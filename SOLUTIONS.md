# Solutions

Spoilers. Try the exercises in PRACTICE.md first.

<details>
<summary>Exercise 2: the 5 bugs in broken-orders</summary>

1. **The API key is read from the wrong place.** `VA-VerifyKey` uses `<APIKey ref="request.queryparam.api-key"/>`. Clients send the key in the `x-api-key` header.
   - Trace: VA-VerifyKey fails with `FailedToResolveAPIKey` and the faultstring "Failed to resolve API Key variable request.queryparam.api-key".
   - Fix: `ref="request.header.x-api-key"`.
2. **The FaultRule condition never matches.** It reads `fault.name = "InvalidAPIKey"`. Fault names are case-sensitive (`InvalidApiKey`), and a missing key raises `FailedToResolveAPIKey`.
   - Trace: the FaultRule row shows `false`.
   - Fix: `(fault.name = "InvalidApiKey") or (fault.name = "FailedToResolveAPIKey")`.
3. **The target path is wrong.** The TargetEndpoint `<Path>/v1</Path>` sends `/v1/orders` to the mock, which returns 404. That becomes an ErrorResponseCode fault.
   - Trace: the target request URL is `http://localhost:9002/v1/orders`.
   - Fix: an empty `<Path/>`.
4. **The listOrders condition is wrong.** It uses `MatchesPath "/orders/*"`, so `GET /orders` never matches and the JS transform never runs.
   - Trace: the Flow listOrders row is `false`.
   - Fix: `MatchesPath "/orders"`.
5. **The CORS step is in the wrong flow.** `AM-AddCORS` is attached to the PostFlow **Request**, so the headers go to the backend, not the client.
   - Trace: the AM-AddCORS changes show `request.header.access-control-allow-origin`.
   - Fix: move the step to the PostFlow `<Response>`. Also add a DefaultFaultRule with `<AlwaysEnforce>true</AlwaysEnforce>` so error responses get CORS too.

</details>

<details>
<summary>Exercise 1: key snippets</summary>

```xml
<VerifyAPIKey name="VA-VerifyKey"><APIKey ref="request.queryparam.apikey"/></VerifyAPIKey>
<SpikeArrest name="SA-SpikeArrest"><Identifier ref="client_id"/><Rate>10pm</Rate></SpikeArrest>
```

Put this in the TargetEndpoint request PreFlow to map `/customers` to `/orders`:

```xml
<AssignMessage name="AM-SetTargetUrl">
    <AssignVariable><Name>target.copy.pathsuffix</Name><Value>false</Value></AssignVariable>
    <AssignVariable><Name>target.url</Name><Template>http://localhost:9002/orders{customer.suffix}</Template></AssignVariable>
</AssignMessage>
```

`customer.suffix` comes from ExtractVariables on `/customers{suffix}` with VariablePrefix `customer`. A simpler alternative is a JavaScript step that does `context.setVariable('target.url', ...)`.

</details>

<details>
<summary>Exercise 3: backend errors</summary>

Add a ProxyEndpoint FaultRule. It also catches TargetEndpoint errors after the target FaultRules have run.

```xml
<FaultRule name="backend-error">
    <Step><Name>AM-BackendError</Name></Step>
    <Condition>(fault.name = "ErrorResponseCode") or (fault.name = "ServiceUnavailable") or (fault.name = "GatewayTimeout")</Condition>
</FaultRule>
```

```xml
<AssignMessage name="AM-BackendError">
    <Set>
        <Payload contentType="application/json">{"error":"backend_error","status":{response.status.code},"messageid":"{messageid}"}</Payload>
    </Set>
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
    <AssignTo createNew="false" type="response"/>
</AssignMessage>
```

- **Why bottom to top:** in the ProxyEndpoint, Edge evaluates FaultRules from the last one to the first. Put the most specific rule last.
- **Only the first match runs** in each endpoint.
- **DefaultFaultRule with AlwaysEnforce** runs even after a FaultRule ran. That makes it the place for cross-cutting work like CORS.

</details>

<details>
<summary>Exercise 6: quota per product</summary>

`countRef`, `Interval ref` and `TimeUnit ref` point at `verifyapikey.VA-VerifyKey.apiproduct.developer.quota.*`. VerifyAPIKey populates those from the product that matched the key. `count` is only the fallback when the reference does not resolve.

To share the quota across all apps of a developer, use `<Identifier ref="developer.email"/>`.

A ResponseCache hit placed after the Quota step still counts, because Quota already ran. If you put ResponseCache before Quota, cache hits skip the rest of the request flow and do not consume quota.

</details>
