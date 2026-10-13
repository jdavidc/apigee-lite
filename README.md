# Apigee Lite

A local practice environment that behaves like Apigee Edge. You build API proxies with the real Edge bundle layout and XML syntax, in the real flow order, using real flow variable names and fault formats. Then you debug them with a Trace view.

It is meant for live-coding interview practice. Fidelity to Edge matters more than looks here.

## Run

```bash
npm install
npm start          # seeds data/ on first run, then starts 3 servers
npm test           # unit + policy + end-to-end tests (node:test)
npm run seed       # resets data/ to the seed content (stop the server first)
```

| Port | Env var | What |
|------|---------|------|
| 9000 | `MGMT_PORT` | Management UI and management API (`/v1/organizations/practice/...`) |
| 9001 | `GATEWAY_PORT` | Gateway runtime: `http://localhost:9001/{basepath}/...` (env `test`) |
| 9002 | `MOCK_PORT` | Built-in mock backend |

`APIGEE_LITE_DATA` overrides the data directory (default `./data`).

**Environments.** `http://localhost:9001` serves `test`. `http://prod.localhost:9001` serves `prod`. You can also send the header `x-apigee-lite-env: prod`.

## Deploy

Requirements: Node.js 20+ (tested on 24), or Docker. The app uses three ports, so deploy it where you control ports: your machine, a Docker host, or a small VM.

### Local (from source)

```bash
git clone https://github.com/jdavidc/apigee-lite.git
cd apigee-lite
npm ci
npm start
```

Open http://localhost:9000.

### Docker

```bash
docker build -t apigee-lite .
docker run -d --name apigee-lite -p 9000:9000 -p 9001:9001 -p 9002:9002 -v apigee-lite-data:/app/data apigee-lite
```

The `apigee-lite-data` volume keeps your proxies across container restarts. To reset to the seed content, remove the volume: `docker rm -f apigee-lite && docker volume rm apigee-lite-data`.

### Linux VM (systemd)

```bash
sudo useradd --system --home /opt/apigee-lite apigee-lite
sudo git clone https://github.com/jdavidc/apigee-lite.git /opt/apigee-lite
cd /opt/apigee-lite && sudo npm ci --omit=dev && sudo chown -R apigee-lite /opt/apigee-lite
```

`/etc/systemd/system/apigee-lite.service`:

```ini
[Unit]
Description=Apigee Lite
After=network.target

[Service]
User=apigee-lite
WorkingDirectory=/opt/apigee-lite
ExecStart=/usr/bin/node server.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now apigee-lite
```

**Security note.** Apigee Lite has no authentication on the management UI or API, and the JavaScript policy runs user code in `node:vm`, which is not a security sandbox. Do not expose it to the public internet. On a remote host, keep the ports closed and reach it through an SSH tunnel:

```bash
ssh -L 9000:localhost:9000 -L 9001:localhost:9001 user@your-vm
```

Single-port platforms (Render, Heroku, Cloud Run) are not supported as-is, because the UI, gateway and mock backend listen on separate ports.

## Seed content

- `orders-v1` (`/orders/v1`): FlowCallout to shared flow `security-baseline`, VerifyAPIKey (`x-api-key` header), SpikeArrest 5ps, Quota taken from the product, conditional flows, ExtractVariables, a JavaScript response transform, AssignMessage CORS, FaultRules, a DefaultFaultRule with AlwaysEnforce, and MessageLogging in the PostClientFlow.
- `oauth` (`/oauth`): `POST /token` (client_credentials) and `GET /protected` (VerifyAccessToken).
- `hello-world` (`/hello`): a no-target proxy built with AssignMessage.
- `broken-orders` (`/broken-orders/v1`): intentionally broken, for PRACTICE.md Exercise 2.
- Shared flow `security-baseline`.
- Products `orders-product` (100/min) and `orders-bronze` (5/min). Developer `jane.doe@example.com`.
- Apps:
  - `practice-app`: key `practice-key-123`, secret `practice-secret-456`.
  - `bronze-app`: key `bronze-key-123`, secret `bronze-secret-456`.
- KVMs `orders-config` and `orders-secrets` (encrypted) in both environments.
- TargetServer `mock-backend` in both environments.

## Sample curl

```bash
curl -i http://localhost:9001/hello
curl -i http://localhost:9001/orders/v1/orders                                   # 401
curl -i -H "x-api-key: practice-key-123" http://localhost:9001/orders/v1/orders  # 200
for i in 1 2 3 4 5 6; do curl -s -o /dev/null -w "%{http_code}\n" -H "x-api-key: practice-key-123" http://localhost:9001/orders/v1/orders & done; wait  # some 429

curl -s -u practice-key-123:practice-secret-456 -d grant_type=client_credentials http://localhost:9001/oauth/token
curl -i -H "Authorization: Bearer <access_token>" http://localhost:9001/oauth/protected

curl -i http://localhost:9002/echo?x=1          # mock backend: /orders, /echo, /status/{code}, /xml, /json, ?delay=ms
```

Management API examples:

```bash
curl http://localhost:9000/v1/organizations/practice/apis
curl -X POST http://localhost:9000/v1/organizations/practice/environments/test/apis/hello-world/revisions/1/deployments
curl -o orders.zip "http://localhost:9000/v1/organizations/practice/apis/orders-v1/revisions/1?format=bundle"
curl -X POST -H "content-type: application/octet-stream" --data-binary @orders.zip "http://localhost:9000/v1/organizations/practice/apis?action=import&name=orders-copy"
```

## UI

- **Left navigation:** API Proxies, Shared Flows, API Products, Developers, Apps, Key Value Maps, Target Servers, Logs, Analytics.
- **Proxy page tabs:**
  - **Overview:** revisions, deploy and undeploy per environment, zip download.
  - **Develop:**
    - A navigator of endpoints, flows, steps, policies and resources.
    - An XML editor with line numbers and live validation (XML errors, unresolved policies, bad conditions, missing targets).
    - **+ Policy** adds a policy from Edge's default template and can attach it to a flow.
    - **+ Step**, **+ Flow** and **+ Resource**.
    - **Save** updates the current revision and hot-redeploys it if it is deployed. **Save as New Revision** creates a new revision. Ctrl+S saves.
  - **Trace:** a request composer and the latest 50 transactions. Trace is always on, so requests you send with curl show up too. Each transaction has a step timeline that shows:
    - conditional flow matching and RouteRules;
    - each policy, executed or skipped, with its condition result, duration, changed variables, `print()` output and errors;
    - the target call and FaultRules;
    - the final flow variables.

## Supported policies

- **Security:**
  - VerifyAPIKey.
  - OAuthV2 (GenerateAccessToken for `client_credentials` and `password`; VerifyAccessToken with scopes, expiry and product match).
  - BasicAuthentication (Encode and Decode), AccessControl (IPRules, X-Forwarded-For), JSONThreatProtection, RegularExpressionProtection.
  - GenerateJWT and VerifyJWT (HS256, HS384, HS512).
- **Traffic:** SpikeArrest (smoothed, or UseEffectiveCount), Quota (count or countRef, Identifier, MessageWeight; calendar, flexi and rollingwindow), ResponseCache, PopulateCache, LookupCache, InvalidateCache.
- **Mediation:**
  - AssignMessage (Copy, Remove, Add, Set, AssignVariable with Value, Ref or Template, AssignTo with createNew, Payload variablePrefix and variableSuffix).
  - ExtractVariables (URIPath, QueryParam, Header, FormParam, Variable, JSONPayload, and simple XMLPayload XPath).
  - RaiseFault, JSONToXML, XMLToJSON.
  - KeyValueMapOperations (Get, Put, Delete, InitialEntries; environment, apiproxy and organization scope; encrypted maps need `private.`).
- **Extension:**
  - Javascript (`node:vm` sandbox with `timeLimit`, `jsc://` ResourceURL and IncludeURL, and `<Properties>`). The sandbox provides:
    - `context.getVariable`, `context.setVariable` and `context.removeVariable`;
    - `context.flow`;
    - `context.proxyRequest`, `context.targetRequest`, `context.targetResponse` and `context.proxyResponse`, each with `headers`, `content`, `status`, `method` and `queryParams`;
    - `print()`.
  - ServiceCallout, FlowCallout (with Parameters), MessageLogging (writes to the in-app Logs page).

Any other policy type deploys with a warning. At runtime it fails with `500 apigeelite.UnsupportedPolicy` ("... is not supported in Apigee Lite"). It never passes silently.

## Runtime behaviour, as in Edge

1. **Flow order:** ProxyEndpoint request PreFlow, then the first matching conditional Flow, then PostFlow. Next, the first matching RouteRule (a rule without a TargetEndpoint is a null route). Then the TargetEndpoint request flows, the target call, the TargetEndpoint response flows, the ProxyEndpoint response flows and the PostClientFlow.
2. **Errors:** a policy fault, or a target status that `success.codes` does not allow (default 1xx, 2xx, 3xx), moves the flow into the error state.
   - A target error keeps the backend body and sets `fault.name = ErrorResponseCode`.
   - TargetEndpoint FaultRules are evaluated top to bottom. ProxyEndpoint FaultRules are evaluated bottom to top. In each endpoint, only the first matching FaultRule runs.
   - The DefaultFaultRule runs when no FaultRule ran, or always when `AlwaysEnforce` is true.
   - A RaiseFault inside a FaultRule stops fault processing.
   - The default body is `{"fault":{"faultstring":"...","detail":{"errorcode":"..."}}}`.
3. **Common fault codes:**

   | Situation | Status | Error code |
   |-----------|--------|------------|
   | Missing API key | 401 | `steps.oauth.v2.FailedToResolveAPIKey` |
   | Invalid API key | 401 | `oauth.v2.InvalidApiKey` |
   | Wrong resource | 401 | `oauth.v2.InvalidApiKeyForGivenResource` |
   | Invalid access token | 401 | `keymanagement.service.invalid_access_token` |
   | Expired access token | 401 | `keymanagement.service.access_token_expired` |
   | Insufficient scope | 403 | `steps.oauth.v2.InsufficientScope` |
   | SpikeArrest violation | 429 | `policies.ratelimit.SpikeArrestViolation` |
   | Quota violation | 429 | `policies.ratelimit.QuotaViolation` |
   | JavaScript error | 500 | `steps.javascript.ScriptExecutionFailed` |
   | Backend down | 503 | `messaging.adaptors.http.flow.ServiceUnavailable` |
   | Unknown base path | 404 | `messaging.adaptors.http.flow.ApplicationNotFound` |

   OAuth GenerateAccessToken errors use Edge's `{"ErrorCode":"invalid_client","Error":"..."}` body.
4. **Conditions:** `= == != := > < >= <=`, `and && or ||`, `not !`, `MatchesPath ~/ LikePath`, `Matches ~ Like`, `JavaRegex ~~`, `StartsWith =|`, parentheses, quoted strings and `null`.
5. **Flow variables:**
   - Message variables: `request.*` (verb, uri, path, querystring, content, header.X, queryparam.X, formparam.X), `response.*` (status.code, content, header.X), `message.*` and `error.*`.
   - Proxy and target: `proxy.basepath`, `proxy.pathsuffix`, `target.url` (settable), `target.copy.pathsuffix`.
   - Request context: `messageid`, `client.ip`, `system.timestamp`, `environment.name`, `organization.name`, `apiproxy.name`, `apiproxy.revision`, `current.flow.name`.
   - Fault state: `fault.name`, `is.error`, `error.state`, `error.message`.
   - Policy outputs (`verifyapikey.{policy}.*`, `ratelimit.{policy}.*`, `jwt.{policy}.*` ...).
   - Message variables created by AssignMessage or ServiceCallout (for example `calloutResponse.content`).

## Differences from real Edge

- One organization (`practice`), two environments (`test`, `prod`), no virtual hosts or TLS, and no users or RBAC.
- The environment is chosen by the `prod.` host prefix, not by org/env hostnames.
- State is in memory and resets on restart: tokens, quota counters, spike arrest, caches, trace, logs and analytics.
- Org data is persisted in `data/org.json`. Bundles are persisted in the Edge layout under `data/apis/<name>/<rev>/apiproxy/`.
- Trace is always on and keeps the last 50 transactions per proxy. Edge needs a debug session.
- `context.proxyRequest` and `context.targetRequest` are the same message object. So are `targetResponse` and `proxyResponse`.
- AssignMessage runs AssignVariable first, then Copy, Remove, Add, Set.
- Templates support `{variable}` only. Message template functions such as `escapeJSON` are not supported.
- OAuthV2 supports GenerateAccessToken (client_credentials and password) and VerifyAccessToken only. There are no refresh tokens or auth codes. Password grant does not validate the user.
- JWT supports HMAC algorithms only (no RS256 or JWKS).
- XMLToJSON and JSONToXML implement the common Options only.
- ExtractVariables XMLPayload supports only simple absolute XPath expressions.
- Quota "distributed/synchronous" flags are accepted and ignored. Calendar windows are aligned to `StartTime`.
- Not supported:
  - LocalTargetConnection, HTTPS targets with TLS settings, Node.js targets, Java and Python callouts, XSL, MessageValidation and SOAP policies, StatisticsCollector.
  - Flow hooks, developer portal and real analytics.
- If you change `MOCK_PORT`, the `mock-backend` TargetServer (host `localhost`) is updated to that port on start.

## Layout

```
server.js                    starts mock, gateway and management servers
src/runtime/                 condition, template, jsonpath, message context, bundle loader, flow executor, trace, gateway
src/runtime/policies/        one module per policy type
src/management/              management REST API and new-bundle templates
src/store/org-store.js       file-backed org data and bundle storage
src/seed.js, seed-content.js seed org and bundles
src/mock/mock-backend.js     mock backend
public/                      vanilla JS UI (no build step) and policy-templates/*.xml
test/                        node:test suites
```
