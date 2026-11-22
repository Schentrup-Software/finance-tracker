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

echo
[ "$FAILS" -eq 0 ] && echo "All API checks passed." || { echo "$FAILS check(s) failed."; exit 1; }
