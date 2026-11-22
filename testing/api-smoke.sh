#!/usr/bin/env bash
# API checks against a local PocketBase (`npm run pb` first). Creates two
# throwaway users through the superuser API and checks that:
#   - each user only sees and links their own records
#   - debt payments move the debt balance
#   - /api/sync/{collection} creates, then updates, by external_id
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

echo
[ "$FAILS" -eq 0 ] && echo "All API checks passed." || { echo "$FAILS check(s) failed."; exit 1; }
