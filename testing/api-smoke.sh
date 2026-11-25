#!/usr/bin/env bash
# API checks against a local PocketBase (`npm run pb` first). Creates two
# throwaway users through the superuser API and checks that:
#   - each user only sees and links their own records
#   - debt payments move the debt balance
#   - /api/sync/{collection} creates, then updates, by external_id
#   - API tokens act as their member until revoked
set -euo pipefail

B="${PB_URL:-http://localhost:8090}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@local.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin12345678}"
FAILS=0

j() { curl -s -H "Content-Type: application/json" "$@"; }
field() { python3 -c "import sys,json; d=json.load(sys.stdin); print(d$1)"; }
check() { if [ "$2" == "$3" ]; then echo "ok   $1"; else echo "FAIL $1 (got '$2', want '$3')"; FAILS=$((FAILS+1)); fi; }

ST=$(j -X POST "$B/api/collections/_superusers/auth-with-password" \
  -d "{\"identity\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" | field '["token"]')

RUN=$RANDOM$RANDOM
token_for() {
  j -H "Authorization: $ST" -X POST "$B/api/collections/users/records" \
    -d "{\"email\":\"$1-$RUN@smoke.test\",\"password\":\"password123\",\"passwordConfirm\":\"password123\"}" > /dev/null
  j -X POST "$B/api/collections/users/auth-with-password" \
    -d "{\"identity\":\"$1-$RUN@smoke.test\",\"password\":\"password123\"}" | field '["token"]'
}
A="Authorization: $(token_for a)"
OTHER="Authorization: $(token_for b)"

check "public sign-up is closed" \
  "$(j -X POST "$B/api/collections/users/records" -d '{"email":"x@smoke.test","password":"password123","passwordConfirm":"password123"}' | field '["status"]')" "403"

ENV=$(j -H "$A" -X POST "$B/api/collections/envelopes/records" -d '{"name":"Groceries","color":"mint"}' | field '["id"]')
check "owner is filled in from the token" "$(j -H "$A" "$B/api/collections/envelopes/records/$ENV" | field '["name"]')" "Groceries"
check "anonymous list is empty" "$(j "$B/api/collections/envelopes/records" | field '["totalItems"]')" "0"
check "another user can't see it" "$(j -H "$OTHER" "$B/api/collections/envelopes/records" | field '["totalItems"]')" "0"
check "another user can't spend from it" \
  "$(j -H "$OTHER" -X POST "$B/api/collections/transactions/records" -d "{\"kind\":\"expense\",\"envelope\":\"$ENV\",\"date\":\"2026-11-21\",\"amount\":5}" | field '["status"]')" "400"

DEBT=$(j -H "$A" -X POST "$B/api/collections/debts/records" -d '{"name":"Visa","balance":1000}' | field '["id"]')
PAY=$(j -H "$A" -X POST "$B/api/collections/debt_payments/records" -d "{\"debt\":\"$DEBT\",\"amount\":250,\"date\":\"2026-11-20\"}" | field '["id"]')
check "payment lowers balance" "$(j -H "$A" "$B/api/collections/debts/records/$DEBT" | field '["balance"]')" "750"
j -H "$A" -X PATCH "$B/api/collections/debt_payments/records/$PAY" -d '{"amount":100}' > /dev/null
check "editing a payment adjusts balance" "$(j -H "$A" "$B/api/collections/debts/records/$DEBT" | field '["balance"]')" "900"
j -H "$A" -X DELETE "$B/api/collections/debt_payments/records/$PAY" > /dev/null
check "deleting a payment restores balance" "$(j -H "$A" "$B/api/collections/debts/records/$DEBT" | field '["balance"]')" "1000"
check "another user can't link my debt to their asset" \
  "$(j -H "$OTHER" -X POST "$B/api/collections/assets/records" -d "{\"name\":\"Car\",\"value\":1,\"debts\":[\"$DEBT\"]}" | field '["status"]')" "400"

j -H "$A" -X POST "$B/api/sync/envelopes" -d '{"records":[{"external_id":"env-gas","name":"Gas"}]}' > /dev/null
check "sync creates" "$(j -H "$A" -X POST "$B/api/sync/transactions" \
  -d '{"records":[{"external_id":"tx-1","kind":"expense","envelope_external_id":"env-gas","date":"2026-11-21","amount":45.5}]}' | field '["created"]')" "1"
check "sync updates on re-run" "$(j -H "$A" -X POST "$B/api/sync/transactions" \
  -d '{"records":[{"external_id":"tx-1","kind":"expense","envelope_external_id":"env-gas","date":"2026-11-21","amount":50}]}' | field '["updated"]')" "1"
check "sync rejects unknown fields" "$(j -H "$A" -X POST "$B/api/sync/transactions" -d '{"records":[{"external_id":"z","bogus":1}]}' | field '["status"]')" "400"
check "sync can't reach another user's records" "$(j -H "$OTHER" -X POST "$B/api/sync/transactions" \
  -d '{"records":[{"external_id":"z","kind":"expense","envelope_external_id":"env-gas","date":"2026-11-21","amount":5}]}' | field '["status"]')" "400"
check "sync requires auth" "$(j -X POST "$B/api/sync/transactions" -d '{"records":[]}' | field '["status"]')" "401"

# Paychecks: one-cent matching, copied paystubs, 401(k) loan lines
status_of() { j -H "$A" "$B/api/collections/transactions/records/$1" | field '["paystub_status"]'; }
balance_of() { j -H "$A" "$B/api/collections/debts/records/$1" | field '["balance"]'; }
EARNER=$(j -H "$A" -X POST "$B/api/collections/earners/records" -d '{"name":"Joey"}' | field '["id"]')
LOAN=$(j -H "$A" -X POST "$B/api/collections/debts/records" -d '{"name":"401k loan","type":"401k_loan","balance":5000}' | field '["id"]')
D1=$(j -H "$A" -X POST "$B/api/collections/transactions/records" -d "{\"kind\":\"income\",\"earner\":\"$EARNER\",\"amount\":2580.10,\"date\":\"2026-11-07 12:00:00.000Z\"}" | field '["id"]')
check "first paycheck asks for a paystub" "$(status_of "$D1")" "needs_paystub"
STUB=$(j -H "$A" -X POST "$B/api/collections/paystubs/records" -d "{\"earner\":\"$EARNER\",\"pay_date\":\"2026-11-07 12:00:00.000Z\",\"gross\":3500,\"net\":2580.10,\"source\":\"upload\"}" | field '["id"]')
j -H "$A" -X POST "$B/api/collections/paystub_lines/records" -d "{\"paystub\":\"$STUB\",\"category\":\"401k_loan\",\"amount\":150,\"debt\":\"$LOAN\"}" > /dev/null
check "uploading the paystub matches the deposit" "$(status_of "$D1")" "matched"
check "loan line pays down the loan" "$(balance_of "$LOAN")" "4850"
D2=$(j -H "$A" -X POST "$B/api/sync/transactions" -d "{\"records\":[{\"external_id\":\"pay-2\",\"kind\":\"income\",\"earner\":\"$EARNER\",\"amount\":2580.11,\"date\":\"2026-11-21\"}]}" | field '["records"][0]["id"]')
check "a paycheck one cent off reuses the paystub" "$(status_of "$D2")" "matched"
check "exactly one copied paystub" "$(j -H "$A" "$B/api/collections/paystubs/records?filter=transaction='$D2'" | field '["totalItems"]')" "1"
check "the copy's loan line pays the loan too" "$(balance_of "$LOAN")" "4700"
D3=$(j -H "$A" -X POST "$B/api/collections/transactions/records" -d "{\"kind\":\"income\",\"earner\":\"$EARNER\",\"amount\":2580.13,\"date\":\"2026-12-05 12:00:00.000Z\"}" | field '["id"]')
check "two cents off the last paycheck asks for a paystub" "$(status_of "$D3")" "needs_paystub"
j -H "$A" -X DELETE "$B/api/collections/transactions/records/$D2" > /dev/null
check "deleting a deposit undoes its copied paystub's loan payment" "$(balance_of "$LOAN")" "4850"
check "another user can't add lines to my paystub" "$(j -H "$OTHER" -X POST "$B/api/collections/paystub_lines/records" -d "{\"paystub\":\"$STUB\",\"category\":\"medical\",\"amount\":1}" | field '["status"]')" "400"
check "another user can't file a paystub under my earner" "$(j -H "$OTHER" -X POST "$B/api/collections/paystubs/records" -d "{\"earner\":\"$EARNER\",\"pay_date\":\"2026-11-07\"}" | field '["status"]')" "400"

# HSA / 401(k) contribution lines feed the linked asset
value_of() { j -H "$A" "$B/api/collections/assets/records/$1" | field '["value"]'; }
HSA=$(j -H "$A" -X POST "$B/api/collections/assets/records" -d '{"name":"HSA","type":"hsa","value":1000}' | field '["id"]')
E2=$(j -H "$A" -X POST "$B/api/collections/earners/records" -d '{"name":"Sam"}' | field '["id"]')
S2=$(j -H "$A" -X POST "$B/api/collections/paystubs/records" -d "{\"earner\":\"$E2\",\"pay_date\":\"2026-11-07 12:00:00.000Z\",\"gross\":3000,\"net\":2000,\"source\":\"upload\"}" | field '["id"]')
L2=$(j -H "$A" -X POST "$B/api/collections/paystub_lines/records" -d "{\"paystub\":\"$S2\",\"category\":\"hsa\",\"amount\":100,\"asset\":\"$HSA\"}" | field '["id"]')
check "an HSA line raises the HSA" "$(value_of "$HSA")" "1100"
j -H "$A" -X PATCH "$B/api/collections/paystub_lines/records/$L2" -d '{"amount":125}' > /dev/null
check "editing the HSA line adjusts it" "$(value_of "$HSA")" "1125"
D4=$(j -H "$A" -X POST "$B/api/collections/transactions/records" -d "{\"kind\":\"income\",\"earner\":\"$E2\",\"amount\":2000,\"date\":\"2026-11-21 12:00:00.000Z\"}" | field '["id"]')
check "a repeat paycheck feeds the HSA again" "$(value_of "$HSA")" "1250"
j -H "$A" -X DELETE "$B/api/collections/transactions/records/$D4" > /dev/null
check "deleting that deposit takes it back out" "$(value_of "$HSA")" "1125"
j -H "$A" -X DELETE "$B/api/collections/paystub_lines/records/$L2" > /dev/null
check "deleting the HSA line takes it back out" "$(value_of "$HSA")" "1000"
OE=$(j -H "$OTHER" -X POST "$B/api/collections/earners/records" -d '{"name":"B"}' | field '["id"]')
OS=$(j -H "$OTHER" -X POST "$B/api/collections/paystubs/records" -d "{\"earner\":\"$OE\",\"pay_date\":\"2026-11-07\"}" | field '["id"]')
check "another user can't feed my HSA" "$(j -H "$OTHER" -X POST "$B/api/collections/paystub_lines/records" -d "{\"paystub\":\"$OS\",\"category\":\"hsa\",\"amount\":1,\"asset\":\"$HSA\"}" | field '["status"]')" "400"
check "my HSA is untouched" "$(value_of "$HSA")" "1000"

# Employer contributions: kept apart from deductions, can feed an asset, copied on repeat paychecks
K401=$(j -H "$A" -X POST "$B/api/collections/assets/records" -d '{"name":"401k","type":"401k","value":2000}' | field '["id"]')
E3=$(j -H "$A" -X POST "$B/api/collections/earners/records" -d '{"name":"Pat"}' | field '["id"]')
S3=$(j -H "$A" -X POST "$B/api/collections/paystubs/records" -d "{\"earner\":\"$E3\",\"pay_date\":\"2026-11-13 12:00:00.000Z\",\"gross\":4791.67,\"net\":2925.35,\"source\":\"upload\"}" | field '["id"]')
j -H "$A" -X POST "$B/api/collections/paystub_lines/records" -d "{\"paystub\":\"$S3\",\"category\":\"roth_401k\",\"amount\":239.58,\"asset\":\"$K401\"}" > /dev/null
check "an employer 401(k) line saves as employer-paid" "$(j -H "$A" -X POST "$B/api/collections/paystub_lines/records" -d "{\"paystub\":\"$S3\",\"category\":\"401k\",\"amount\":191.67,\"asset\":\"$K401\",\"employer_paid\":true}" | field '["employer_paid"]')" "True"
check "employee and employer contributions both raise the 401(k)" "$(value_of "$K401")" "2431.25"
D5=$(j -H "$A" -X POST "$B/api/collections/transactions/records" -d "{\"kind\":\"income\",\"earner\":\"$E3\",\"amount\":2925.35,\"date\":\"2026-11-27 12:00:00.000Z\"}" | field '["id"]')
COPY=$(j -H "$A" "$B/api/collections/paystubs/records?filter=transaction='$D5'" | field '["items"][0]["id"]')
check "a repeat paycheck copies the employer line" "$(j -H "$A" "$B/api/collections/paystub_lines/records?filter=paystub='$COPY'%26%26employer_paid=true" | field '["totalItems"]')" "1"

# Reimbursements: the deposit is net pay plus reimbursements (the check amount)
E4=$(j -H "$A" -X POST "$B/api/collections/earners/records" -d '{"name":"Lee"}' | field '["id"]')
D6=$(j -H "$A" -X POST "$B/api/collections/transactions/records" -d "{\"kind\":\"income\",\"earner\":\"$E4\",\"amount\":3188.52,\"date\":\"2026-11-13 12:00:00.000Z\"}" | field '["id"]')
check "a deposit with a reimbursement asks for a paystub" "$(status_of "$D6")" "needs_paystub"
S4=$(j -H "$A" -X POST "$B/api/collections/paystubs/records" -d "{\"earner\":\"$E4\",\"pay_date\":\"2026-11-13 12:00:00.000Z\",\"gross\":4791.67,\"net\":2925.35,\"deposit\":3188.52,\"source\":\"upload\"}" | field '["id"]')
j -H "$A" -X POST "$B/api/collections/paystub_lines/records" -d "{\"paystub\":\"$S4\",\"category\":\"reimbursement\",\"label\":\"Gusto Health Insurance Offset\",\"amount\":263.17}" > /dev/null
check "the paystub's check amount matches the deposit" "$(status_of "$D6")" "matched"
D7=$(j -H "$A" -X POST "$B/api/collections/transactions/records" -d "{\"kind\":\"income\",\"earner\":\"$E4\",\"amount\":3188.53,\"date\":\"2026-11-27 12:00:00.000Z\"}" | field '["id"]')
check "a check one cent off reuses the paystub" "$(status_of "$D7")" "matched"
check "the copy keeps the take-home apart from the reimbursement" "$(j -H "$A" "$B/api/collections/paystubs/records?filter=transaction='$D7'" | field '["items"][0]["net"]')" "2925.36"

# Backfill: a saved paystub fills in earlier waiting deposits with the same check amount
E5=$(j -H "$A" -X POST "$B/api/collections/earners/records" -d '{"name":"Kim"}' | field '["id"]')
D8=$(j -H "$A" -X POST "$B/api/collections/transactions/records" -d "{\"kind\":\"income\",\"earner\":\"$E5\",\"amount\":1500,\"date\":\"2026-10-16 12:00:00.000Z\"}" | field '["id"]')
D9=$(j -H "$A" -X POST "$B/api/collections/transactions/records" -d "{\"kind\":\"income\",\"earner\":\"$E5\",\"amount\":1500.01,\"date\":\"2026-10-30 12:00:00.000Z\"}" | field '["id"]')
D10=$(j -H "$A" -X POST "$B/api/collections/transactions/records" -d "{\"kind\":\"income\",\"earner\":\"$E5\",\"amount\":1400,\"date\":\"2026-10-02 12:00:00.000Z\"}" | field '["id"]')
D11=$(j -H "$A" -X POST "$B/api/collections/transactions/records" -d "{\"kind\":\"income\",\"earner\":\"$E5\",\"amount\":1499.99,\"date\":\"2026-11-27 12:00:00.000Z\"}" | field '["id"]')
D12=$(j -H "$A" -X POST "$B/api/collections/transactions/records" -d '{"kind":"income","payee":"Gusto","amount":1500.01,"date":"2026-09-30 12:00:00.000Z"}' | field '["id"]')
D13=$(j -H "$A" -X POST "$B/api/collections/transactions/records" -d "{\"kind\":\"income\",\"payee\":\"Refund\",\"envelope\":\"$ENV\",\"amount\":1500,\"date\":\"2026-09-30 12:00:00.000Z\"}" | field '["id"]')
LOAN2=$(j -H "$A" -X POST "$B/api/collections/debts/records" -d '{"name":"Kim 401k loan","type":"401k_loan","balance":3000}' | field '["id"]')
S5=$(j -H "$A" -X POST "$B/api/collections/paystubs/records" -d "{\"earner\":\"$E5\",\"pay_date\":\"2026-11-13 12:00:00.000Z\",\"gross\":2000,\"net\":1500,\"source\":\"upload\"}" | field '["id"]')
j -H "$A" -X POST "$B/api/collections/paystub_lines/records" -d "{\"paystub\":\"$S5\",\"category\":\"401k_loan\",\"amount\":100,\"debt\":\"$LOAN2\"}" > /dev/null
check "another household can't backfill my paystub" "$(j -H "$OTHER" -X POST "$B/api/paystubs/$S5/backfill" | field '["status"]')" "404"
check "backfill fills in the matching deposits before and after, a cent either way" "$(j -H "$A" -X POST "$B/api/paystubs/$S5/backfill" | field '["filled"]')" "4"
check "the earlier deposit is matched" "$(status_of "$D8")" "matched"
check "the one a cent off is matched too" "$(status_of "$D9")" "matched"
check "a later deposit a cent under is matched too" "$(status_of "$D11")" "matched"
check "an imported paycheck with no earner is matched" "$(status_of "$D12")" "matched"
check "and gets the earner" "$(j -H "$A" "$B/api/collections/transactions/records/$D12" | field '["earner"]')" "$E5"
check "money back into an envelope is left alone" "$(j -H "$A" "$B/api/collections/transactions/records/$D13" | field '["earner"]')" ""
check "a different amount still asks for a paystub" "$(status_of "$D10")" "needs_paystub"
check "only the later paycheck pays the loan added after the earlier ones" "$(balance_of "$LOAN2")" "2800"
check "backfilling again finds nothing new" "$(j -H "$A" -X POST "$B/api/paystubs/$S5/backfill" | field '["filled"]')" "0"
D14=$(j -H "$A" -X POST "$B/api/collections/transactions/records" -d '{"kind":"income","payee":"Gusto","amount":1500,"date":"2026-09-16 12:00:00.000Z"}' | field '["id"]')
j -H "$A" -X PATCH "$B/api/collections/transactions/records/$D14" -d "{\"earner\":\"$E5\"}" > /dev/null
check "marking an old deposit as a paycheck matches the next paystub" "$(status_of "$D14")" "matched"

# A paystub saved without its deposit gets linked to it (even an imported one), not copied onto it
E6=$(j -H "$A" -X POST "$B/api/collections/earners/records" -d '{"name":"Ash"}' | field '["id"]')
D15=$(j -H "$A" -X POST "$B/api/collections/transactions/records" -d '{"kind":"income","payee":"Gusto","amount":3188.52,"date":"2026-11-13 12:00:00.000Z"}' | field '["id"]')
D16=$(j -H "$A" -X POST "$B/api/collections/transactions/records" -d '{"kind":"income","payee":"Gusto","amount":3188.53,"date":"2026-10-30 12:00:00.000Z"}' | field '["id"]')
S6=$(j -H "$A" -X POST "$B/api/collections/paystubs/records" -d "{\"earner\":\"$E6\",\"pay_date\":\"2026-11-13 12:00:00.000Z\",\"gross\":4791.67,\"net\":2925.35,\"deposit\":3188.52,\"source\":\"upload\"}" | field '["id"]')
check "the paystub is linked to its own imported deposit" "$(j -H "$A" "$B/api/collections/paystubs/records/$S6" | field '["transaction"]')" "$D15"
check "backfill only fills the earlier one" "$(j -H "$A" -X POST "$B/api/paystubs/$S6/backfill" | field '["filled"]')" "1"
check "one paystub per deposit" "$(j -H "$A" "$B/api/collections/paystubs/records?filter=earner='$E6'" | field '["totalItems"]')" "2"
# Cleaning up a copy that was put on the paystub's own deposit: saving the paystub replaces it.
E7=$(j -H "$A" -X POST "$B/api/collections/earners/records" -d '{"name":"Bo"}' | field '["id"]')
D17=$(j -H "$A" -X POST "$B/api/collections/transactions/records" -d "{\"kind\":\"income\",\"earner\":\"$E7\",\"amount\":900,\"date\":\"2026-11-13 12:00:00.000Z\"}" | field '["id"]')
j -H "$A" -X POST "$B/api/collections/paystubs/records" -d "{\"earner\":\"$E7\",\"pay_date\":\"2026-11-13 12:00:00.000Z\",\"gross\":1000,\"net\":900,\"source\":\"repeat\",\"transaction\":\"$D17\"}" > /dev/null
S7=$(j -H "$A" -X POST "$B/api/collections/paystubs/records" -d "{\"earner\":\"$E7\",\"pay_date\":\"2026-11-13 12:00:00.000Z\",\"gross\":1000,\"net\":900,\"source\":\"upload\"}" | field '["id"]')
check "saving the real paystub takes over its deposit" "$(j -H "$A" "$B/api/collections/paystubs/records/$S7" | field '["transaction"]')" "$D17"
check "and removes the copy that was on it" "$(j -H "$A" "$B/api/collections/paystubs/records?filter=earner='$E7'" | field '["totalItems"]')" "1"

# Annual envelopes, imported months and opening balances
carried_of() { j -H "$A" "$B/api/finance/balances?month=$1" | field "[\"carried\"][\"$2\"]"; }
XMAS=$(j -H "$A" -X POST "$B/api/sync/envelopes" -d '{"records":[{"external_id":"imp-xmas","name":"Christmas","period":"annual","goal":3600,"rollover":true,"opening_balance":500,"opening_date":"2026-11-10 23:59:59.999Z"}]}' | field '["records"][0]["id"]')
check "import creates months" "$(j -H "$A" -X POST "$B/api/import/budgets" -d '{"months":[{"month":"2031-11","planned_income":100,"allocations":[{"envelope_external_id":"imp-xmas","amount":-50}]},{"month":"2031-12","allocations":[{"envelope_external_id":"imp-xmas","amount":300}]}]}' | field '["budgets_created"]')" "2"
j -H "$A" -X PATCH "$B/api/collections/envelopes/records/$XMAS" -d '{"opening_date":"2031-11-10 23:59:59.999Z"}' > /dev/null
j -H "$A" -X POST "$B/api/sync/transactions" -d '{"records":[{"external_id":"imp-1","kind":"expense","envelope_external_id":"imp-xmas","amount":20.5,"date":"2031-11-05 12:00:00.000Z","account":"Visa"},{"external_id":"imp-2","kind":"expense","envelope_external_id":"imp-xmas","amount":30,"date":"2031-11-15 12:00:00.000Z"},{"external_id":"imp-3","kind":"income","envelope_external_id":"imp-xmas","amount":10.25,"date":"2031-11-16 12:00:00.000Z"}]}' > /dev/null
check "opening month backs out what came before it" "$(carried_of 2031-11 "$XMAS")" "570.5"
check "next month starts from the opening balance" "$(carried_of 2031-12 "$XMAS")" "480.25"
check "and carries the month's allocation on" "$(carried_of 2032-01 "$XMAS")" "780.25"
check "spent this year counts spending only" "$(j -H "$A" "$B/api/finance/balances?month=2031-12" | field "[\"year_spent\"][\"$XMAS\"]")" "50.5"
check "importing the same month again doesn't duplicate it" "$(j -H "$A" -X POST "$B/api/import/budgets" -d '{"months":[{"month":"2031-12","allocations":[{"envelope_external_id":"imp-xmas","amount":300}]}]}' | field '["budgets_created"]')" "0"
check "an imported month is marked imported" "$(j -H "$A" "$B/api/collections/budgets/records?filter=month='2031-11'" | field '["items"][0]["imported"]')" "True"
check "another user can't import into my envelopes" "$(j -H "$OTHER" -X POST "$B/api/import/budgets" -d '{"months":[{"month":"2031-11","allocations":[{"envelope_external_id":"imp-xmas","amount":1}]}]}' | field '["status"]')" "400"
check "another user doesn't see my balances" "$(j -H "$OTHER" "$B/api/finance/balances?month=2031-12" | field '["carried"]')" "{}"
check "balances need a sign-in" "$(j "$B/api/finance/balances?month=2031-12" | field '["status"]')" "401"

# Households: the head adds members, and everyone in the household shares the data
ADDED=$(j -H "$A" -X POST "$B/api/household/members" -d "{\"email\":\"m-$RUN@smoke.test\",\"name\":\"Brie\",\"password\":\"password123\"}")
check "the head adds a household member" "$(echo "$ADDED" | field '["name"]')" "Brie"
MEMBER_ID=$(echo "$ADDED" | field '["id"]')
M="Authorization: $(j -X POST "$B/api/collections/users/auth-with-password" -d "{\"identity\":\"m-$RUN@smoke.test\",\"password\":\"password123\"}" | field '["token"]')"
check "a member sees the household's envelopes" "$(j -H "$M" "$B/api/collections/envelopes/records/$ENV" | field '["name"]')" "Groceries"
MENV=$(j -H "$M" -X POST "$B/api/collections/envelopes/records" -d '{"name":"Date night"}' | field '["id"]')
check "a member's new envelope belongs to the household" "$(j -H "$A" "$B/api/collections/envelopes/records/$MENV" | field '["name"]')" "Date night"
check "a member can spend from a shared envelope" "$(j -H "$M" -X POST "$B/api/collections/transactions/records" -d "{\"kind\":\"expense\",\"envelope\":\"$ENV\",\"date\":\"2026-11-21\",\"amount\":5}" | field '["kind"]')" "expense"
check "a member's sync writes to the household" "$(j -H "$M" -X POST "$B/api/sync/envelopes" -d '{"records":[{"external_id":"env-gas","name":"Gas"}]}' | field '["updated"]')" "1"
check "a member sees the head in the household list" "$(j -H "$M" "$B/api/collections/users/records" | field '["totalItems"]')" "2"
check "another household still sees nothing" "$(j -H "$OTHER" "$B/api/collections/envelopes/records/$MENV" | field '["status"]')" "404"
check "another household can't see our members" "$(j -H "$OTHER" "$B/api/collections/users/records" | field '["totalItems"]')" "1"
check "a member can't add people" "$(j -H "$M" -X POST "$B/api/household/members" -d '{"email":"x@smoke.test","password":"password123"}' | field '["status"]')" "403"
check "a member can't move themself to another household" "$(j -H "$M" -X PATCH "$B/api/collections/users/records/$MEMBER_ID" -d "{\"household\":\"$MEMBER_ID\"}" | field '["status"]')" "404"
check "another head can't remove our member" "$(j -H "$OTHER" -X DELETE "$B/api/household/members/$MEMBER_ID" | field '["status"]')" "404"
MKEY=$(j -H "$M" -X POST "$B/api/tokens" -d '{"name":"member script"}' | field '["token"]')
check "the head resets a member's password" "$(j -H "$A" -X POST "$B/api/household/members/$MEMBER_ID/password" -d '{"password":"newpassword456"}' | field '["ok"]')" "True"
check "a token outlives a password change" "$(j -H "Authorization: $MKEY" "$B/api/collections/envelopes/records/$MENV" | field '["name"]')" "Date night"
check "a member's token works" "$(j -H "Authorization: $MKEY" "$B/api/collections/envelopes/records/$MENV" | field '["name"]')" "Date night"
check "the head removes a member" "$(j -H "$A" -X DELETE "$B/api/household/members/$MEMBER_ID" | field '["ok"]')" "True"
check "a removed member's token stops working" "$(j -H "Authorization: $MKEY" "$B/api/collections/envelopes/records" | field '["status"]')" "401"
check "a removed member can't sign in" "$(j -X POST "$B/api/collections/users/auth-with-password" -d "{\"identity\":\"m-$RUN@smoke.test\",\"password\":\"newpassword456\"}" | field '["status"]')" "400"
check "their envelope stays with the household" "$(j -H "$A" "$B/api/collections/envelopes/records/$MENV" | field '["name"]')" "Date night"

# Vendors: matched from the statement text, back-filled, merged; tax fields and documents stay in the household
vendor_of() { j -H "$A" "$B/api/collections/transactions/records/$1" | field '["vendor"]'; }
BILLS=$(j -H "$A" -X POST "$B/api/collections/envelopes/records" -d '{"name":"Bills"}' | field '["id"]')
OLD=$(j -H "$A" -X POST "$B/api/collections/transactions/records" -d '{"kind":"expense","amount":200,"date":"2026-12-01","payee":"PAYPAL *STMARYSCHURCH 402-555-0100"}' | field '["id"]')
CHURCH=$(j -H "$A" -X POST "$B/api/collections/vendors/records" -d "{\"name\":\"St Marys\",\"matches\":[\"PAYPAL *STMARYSCHURCH\"],\"default_envelope\":\"$BILLS\",\"tax_category\":\"charity\",\"external_id\":\"church\"}" | field '["id"]')
check "an earlier payment isn't matched until back-filled" "$(vendor_of "$OLD")" ""
check "back-fill links earlier payments" "$(j -H "$A" -X POST "$B/api/vendors/$CHURCH/backfill" | field '["matched"]')" "1"
check "back-filled payment has the vendor" "$(vendor_of "$OLD")" "$CHURCH"
NEW=$(j -H "$A" -X POST "$B/api/sync/transactions" -d '{"records":[{"external_id":"bank-77","kind":"expense","amount":200,"date":"2027-01-01","payee":"PayPal *StMarysChurch 402-555-0177"}]}' | field '["records"][0]["id"]')
check "a synced payment is matched on its statement text" "$(vendor_of "$NEW")" "$CHURCH"
check "and lands in the vendor's usual envelope" "$(j -H "$A" "$B/api/collections/transactions/records/$NEW" | field '["envelope"]')" "$BILLS"
j -H "$A" -X PATCH "$B/api/collections/transactions/records/$NEW" -d '{"payee":"Shell Oil 1234"}' > /dev/null
check "changing the statement text matches again" "$(vendor_of "$NEW")" ""
PICKED=$(j -H "$A" -X POST "$B/api/collections/transactions/records" -d "{\"kind\":\"expense\",\"amount\":5,\"date\":\"2027-01-02\",\"payee\":\"Cash at church\",\"vendor\":\"$CHURCH\",\"vendor_locked\":true}" | field '["id"]')
check "a vendor picked by hand stays" "$(vendor_of "$PICKED")" "$CHURCH"
check "a sync can name the vendor" "$(j -H "$A" -X POST "$B/api/sync/transactions" -d '{"records":[{"external_id":"bank-78","kind":"expense","amount":9,"date":"2027-01-03","payee":"Cash","vendor_external_id":"church"}]}' | field '["records"][0]["vendor_locked"]')" "True"
j -H "$A" -X POST "$B/api/collections/transactions/records" -d '{"kind":"expense","amount":20,"date":"2027-01-02","payee":"PUBLIX #1234"}' > /dev/null
j -H "$A" -X POST "$B/api/collections/transactions/records" -d '{"kind":"expense","amount":25,"date":"2027-01-09","payee":"Publix #999"}' > /dev/null
check "unmatched statement text is grouped by its stable start" "$(j -H "$A" "$B/api/vendors/unmatched" | python3 -c 'import sys,json; print([(i["pattern"],i["count"]) for i in json.load(sys.stdin)["items"] if i["pattern"]=="PUBLIX"])')" "[('PUBLIX', 2)]"
PUB=$(j -H "$A" -X POST "$B/api/collections/vendors/records" -d '{"name":"Publix","matches":["PUBLIX"]}' | field '["id"]')
j -H "$A" -X POST "$B/api/vendors/$PUB/backfill" > /dev/null
check "merging moves the payments" "$(j -H "$A" -X POST "$B/api/vendors/$PUB/merge" -d "{\"into\":\"$CHURCH\"}" | field '["moved"]')" "2"
check "and the statement text" "$(j -H "$A" "$B/api/collections/vendors/records/$CHURCH" | field '["matches"]')" "['PAYPAL *STMARYSCHURCH', 'PUBLIX']"
check "another household can't see my vendors" "$(j -H "$OTHER" "$B/api/collections/vendors/records/$CHURCH" | field '["status"]')" "404"
check "another household can't tag a payment with my vendor" "$(j -H "$OTHER" -X POST "$B/api/collections/transactions/records" -d "{\"kind\":\"expense\",\"amount\":1,\"date\":\"2027-01-01\",\"vendor\":\"$CHURCH\"}" | field '["status"]')" "400"
check "another household can't back-fill my vendor" "$(j -H "$OTHER" -X POST "$B/api/vendors/$CHURCH/backfill" | field '["status"]')" "404"
check "another household's sync doesn't match my vendors" "$(j -H "$OTHER" -X POST "$B/api/sync/transactions" -d '{"records":[{"external_id":"x-1","kind":"expense","amount":1,"date":"2027-01-01","payee":"PAYPAL *STMARYSCHURCH 1"}]}' | field '["records"][0]["vendor"]')" ""
check "another household can't point a vendor at my envelope" "$(j -H "$OTHER" -X POST "$B/api/collections/vendors/records" -d "{\"name\":\"x\",\"default_envelope\":\"$BILLS\"}" | field '["status"]')" "400"
printf '%%PDF-1.4\n%%%%EOF\n' > /tmp/smoke-receipt.pdf
DOC=$(curl -s -H "$A" -X POST "$B/api/collections/tax_documents/records" -F "file=@/tmp/smoke-receipt.pdf;type=application/pdf" -F "tax_year=2027" -F "kind=year_end_statement" -F "vendor=$CHURCH" | field '["id"]')
check "a year-end statement is stored for the household" "$(j -H "$A" "$B/api/collections/tax_documents/records/$DOC" | field '["kind"]')" "year_end_statement"
check "another household can't attach to my vendor" "$(curl -s -H "$OTHER" -X POST "$B/api/collections/tax_documents/records" -F "file=@/tmp/smoke-receipt.pdf;type=application/pdf" -F "tax_year=2027" -F "vendor=$CHURCH" | field '["status"]')" "400"
check "tax years are one per household per year" "$(j -H "$A" -X POST "$B/api/collections/tax_years/records" -d '{"year":2027,"agi":1}' > /dev/null; j -H "$A" -X POST "$B/api/collections/tax_years/records" -d '{"year":2027,"agi":2}' | field '["status"]')" "400"

# API tokens: never expire, act as the member who made them, revoked one at a time
check "a token needs a name" "$(j -H "$A" -X POST "$B/api/tokens" -d '{"name":" "}' | field '["status"]')" "400"
MADE=$(j -H "$A" -X POST "$B/api/tokens" -d '{"name":"n8n"}')
KEY=$(echo "$MADE" | field '["token"]')
KEY_ID=$(echo "$MADE" | field '["id"]')
K="Authorization: $KEY"
check "a token starts with ft_" "${KEY:0:3}" "ft_"
check "the token is listed, without its secret" "$(j -H "$A" "$B/api/tokens" | python3 -c 'import sys,json; print([(t["name"], "token" in t, "token_hash" in t) for t in json.load(sys.stdin)["items"]])')" "[('n8n', False, False)]"
check "a token reads the household's records" "$(j -H "$K" "$B/api/collections/envelopes/records/$ENV" | field '["name"]')" "Groceries"
check "a token works as a Bearer header too" "$(j -H "Authorization: Bearer $KEY" "$B/api/collections/envelopes/records/$ENV" | field '["name"]')" "Groceries"
TENV=$(j -H "$K" -X POST "$B/api/collections/envelopes/records" -d '{"name":"Made by n8n"}' | field '["id"]')
check "a token creates records for the household" "$(j -H "$A" "$B/api/collections/envelopes/records/$TENV" | field '["name"]')" "Made by n8n"
check "a token syncs" "$(j -H "$K" -X POST "$B/api/sync/transactions" -d '{"records":[{"external_id":"tok-1","kind":"expense","date":"2026-11-21","amount":1}]}' | field '["created"]')" "1"
check "a token notes when it was used" "$(j -H "$A" "$B/api/tokens" | python3 -c 'import sys,json; print(bool(json.load(sys.stdin)["items"][0]["last_used"]))')" "True"
check "a token can't list tokens" "$(j -H "$K" "$B/api/tokens" | field '["status"]')" "403"
check "a token can't make tokens" "$(j -H "$K" -X POST "$B/api/tokens" -d '{"name":"x"}' | field '["status"]')" "403"
check "a token can't be swapped for a sign-in" "$(j -H "$K" -X POST "$B/api/collections/users/auth-refresh" | field '["status"]')" "403"
check "tokens aren't readable through the collection API" "$(j -H "$A" "$B/api/collections/api_tokens/records" | field '["status"]')" "403"
check "another household doesn't see my tokens" "$(j -H "$OTHER" "$B/api/tokens" | field '["items"]')" "[]"
check "another household can't revoke my token" "$(j -H "$OTHER" -X DELETE "$B/api/tokens/$KEY_ID" | field '["status"]')" "404"
check "another household's records stay hidden from my token" "$(j -H "$K" "$B/api/collections/envelopes/records" | python3 -c 'import sys,json; print(all(r["owner"] == sys.argv[1] for r in json.load(sys.stdin)["items"]))' "$(j -H "$A" "$B/api/collections/envelopes/records/$ENV" | field '["owner"]')")" "True"
check "revoking a token" "$(j -H "$A" -X DELETE "$B/api/tokens/$KEY_ID" | field '["ok"]')" "True"
check "a revoked token gets 401" "$(j -H "$K" "$B/api/collections/envelopes/records" | field '["status"]')" "401"
check "a made-up token gets 401" "$(j -H "Authorization: ft_nope" "$B/api/sync/transactions" -X POST -d '{"records":[]}' | field '["status"]')" "401"

echo
[ "$FAILS" -eq 0 ] && echo "All API checks passed." || { echo "$FAILS check(s) failed."; exit 1; }
