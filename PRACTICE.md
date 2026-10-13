# Practice exercises

These exercises mirror typical Apigee live-coding interview tasks. Each one has a time box and a grade (★ easy to ★★★ hard). Work in the UI (Develop and Trace) and edit the XML by hand where you can, because that is what transfers to real Edge.

Before each session, run `npm run seed` to start clean. Solutions are in [SOLUTIONS.md](SOLUTIONS.md). Try first.

## Exercise 1: Build a proxy from scratch ★ (20 min)

Create `customers-v1` with base path `/customers/v1` that reverse-proxies the mock backend's `/orders` resources.

1. Use the New Proxy wizard with the "Mock backend" type. Then read the generated ProxyEndpoint, TargetEndpoint and LoadBalancer XML.
2. Add VerifyAPIKey that reads the key from the query parameter `apikey`. Add the proxy to `orders-product` (API Products page) so `practice-key-123` works.
3. Add SpikeArrest `10pm` per `client_id`.
4. Add conditional flows `listCustomers` (`GET /customers`) and `getCustomer` (`GET /customers/*`). Map `/customers` to `/orders` on the backend: set `target.copy.pathsuffix` to `false`, or use AssignMessage or `target.url` in the TargetEndpoint.
5. Add a catch-all flow that returns `404` with RaiseFault.
6. Deploy to `test`. Then check:
   - no key gives 401;
   - `?apikey=practice-key-123` gives 200;
   - an unknown path gives 404;
   - fast repeated calls give 429.

**Done when** all four checks pass and Trace shows the expected flow matched.

## Exercise 2: Debug a broken proxy ★★ (25 min)

`broken-orders` (`/broken-orders/v1`) should behave like `orders-v1`:

- the API key is sent in the `x-api-key` header;
- `GET /orders` returns the `{count, orders}` envelope;
- CORS headers are present on every response;
- invalid keys get the custom JSON from `AM-InvalidApiKey`.

```bash
curl -i -H "x-api-key: practice-key-123" http://localhost:9001/broken-orders/v1/orders
```

It currently fails. Use **Trace only** (no diffing against orders-v1) to find and fix **5 bugs**. For each one, write down which Trace detail gave it away: a skipped step, a condition result `false`, the target URL, a changed variable, or the fault name.

## Exercise 3: Fix the FaultRules ★★ (20 min)

In `orders-v1`:

1. Make backend errors (target 4xx/5xx) return a uniform body: `{"error":"backend_error","status":<code>,"messageid":"..."}`. Keep the original status code. Test with a flow that calls the mock's `/status/503`, or point a TargetServer at a dead port to produce a 503 `ServiceUnavailable`.
2. Make sure the CORS headers are still added on every error.
3. Explain the evaluation order: why ProxyEndpoint FaultRules are evaluated bottom to top, why `AlwaysEnforce` matters, and what happens if two FaultRule conditions both match.
4. Make a Quota violation return `429` with a `Retry-After` header computed from `ratelimit.Q-ProductQuota.expiry.time`. Use JavaScript.

## Exercise 4: JavaScript transformation ★★ (20 min)

1. In `orders-v1`, change `GET /orders/{id}` so the response becomes:

   ```json
   {"orderId":"1","customer":{"name":"Ada Lovelace"},"lines":[{"item":"...","qty":1,"unitPrice":42.5}],"total":42.5,"_links":{"self":"/orders/v1/orders/1"}}
   ```

   - Use a Javascript policy in the response flow and `context.getVariable('response.content')`.
   - Use `print()` for debugging and find the output in Trace.
   - Set `timeLimit` and handle bad JSON from the backend by returning a 502 with RaiseFault.
2. Add a query param `?fields=id,status` that filters the list response (`GET /orders`) in the same script.

## Exercise 5: OAuth flow ★★ (25 min)

1. Use the seeded `oauth` proxy to get a token, then call `/oauth/protected`.
2. Create `orders-v2` (`/orders/v2`) secured with OAuthV2 VerifyAccessToken instead of an API key. Require the scope `read` on `GET` and `write` on `POST`. Check:
   - the 403 InsufficientScope response;
   - 401 for a missing, invalid or expired token (set `ExpiresIn` to 10000 in a copy of the token policy).
3. Add `orders-v2` to `orders-product`. What happens if you forget? Name the error code.
4. Bonus: issue a JWT with GenerateJWT after the token call, signed with the `jwt-signing-key` from the encrypted KVM `orders-secrets`. Read it into a `private.` variable with KeyValueMapOperations. Verify the JWT in `orders-v2` with VerifyJWT.

## Exercise 6: Quota per product ★★★ (25 min)

1. Call `orders-v1` with `bronze-key-123` (product `orders-bronze`, 5 per minute) and with `practice-key-123` (100 per minute). Watch `ratelimit.Q-ProductQuota.*` in Trace.
2. Explain why the limit differs per caller with the same Quota policy, and what the `count` attribute is used for.
3. Add a third product `orders-gold` (1000 per hour) and a new app. Verify that the quota, interval and time unit all come from the product.
4. Change the Quota Identifier so the quota is shared by all apps of the same developer (`developer.email`) instead of per app. When would you want that?
5. Bonus: add ResponseCache on `GET /orders` keyed by `request.uri` with a 30 s TTL, and prove with Trace that the target is skipped on a hit. Does the cache hit still count against the Quota? Why?

## Exercise 7: Mediation drills ★ (15 min, repeatable)

Write each policy from memory in the XML editor, then verify in Trace:

- ExtractVariables: get `customer.name` from a JSON body and the `{id}` from the path.
- AssignMessage: create a new request message `myRequest`, then call the mock `/echo` with ServiceCallout and copy one field into the response.
- XMLToJSON: on a flow that targets the mock `/xml`, return JSON to the client.
- KeyValueMapOperations: read `greeting` from `orders-config` and return it in a header.
- AccessControl: deny `127.0.0.1/32`, check that you get 403, then allow it again.
