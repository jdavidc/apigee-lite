'use strict';
// Seed bundles in real Edge layout. Loaded into data/ by `npm run seed` (or on first start).

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const step = (name, cond, indent = '            ') => `${indent}<Step>\n${indent}    <Name>${name}</Name>\n${cond ? `${indent}    <Condition>${cond}</Condition>\n` : ''}${indent}</Step>`;

const descriptor = (name, desc, targets) => `${XML}<APIProxy revision="1" name="${name}">
    <DisplayName>${name}</DisplayName>
    <Description>${desc}</Description>
    <ProxyEndpoints>
        <ProxyEndpoint>default</ProxyEndpoint>
    </ProxyEndpoints>
${targets ? '    <TargetEndpoints>\n        <TargetEndpoint>default</TargetEndpoint>\n    </TargetEndpoints>\n' : ''}</APIProxy>
`;

const mockTarget = (path = '', desc = 'Mock backend via TargetServer') => `${XML}<TargetEndpoint name="default">
    <Description>${desc}</Description>
    <FaultRules/>
    <PreFlow name="PreFlow">
        <Request/>
        <Response/>
    </PreFlow>
    <PostFlow name="PostFlow">
        <Request/>
        <Response/>
    </PostFlow>
    <Flows/>
    <HTTPTargetConnection>
        <LoadBalancer>
            <Server name="mock-backend"/>
        </LoadBalancer>
        <Path>${path}</Path>
        <Properties>
            <Property name="io.timeout.millis">10000</Property>
        </Properties>
    </HTTPTargetConnection>
</TargetEndpoint>
`;

const corsPolicy = `${XML}<AssignMessage async="false" continueOnError="false" enabled="true" name="AM-AddCORS">
    <DisplayName>AM-AddCORS</DisplayName>
    <Set>
        <Headers>
            <Header name="Access-Control-Allow-Origin">*</Header>
            <Header name="Access-Control-Allow-Headers">origin, x-requested-with, accept, content-type, x-api-key</Header>
            <Header name="Access-Control-Allow-Methods">GET, PUT, POST, DELETE</Header>
        </Headers>
    </Set>
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
    <AssignTo createNew="false" transport="http" type="response"/>
</AssignMessage>
`;

const verifyKey = (ref) => `${XML}<VerifyAPIKey async="false" continueOnError="false" enabled="true" name="VA-VerifyKey">
    <DisplayName>VA-VerifyKey</DisplayName>
    <APIKey ref="${ref}"/>
</VerifyAPIKey>
`;

const invalidKeyResponse = `${XML}<AssignMessage async="false" continueOnError="false" enabled="true" name="AM-InvalidApiKey">
    <DisplayName>AM-InvalidApiKey</DisplayName>
    <Set>
        <Payload contentType="application/json">{"error":"unauthorized","message":"A valid API key must be sent in the x-api-key header","fault":"{fault.name}","messageid":"{messageid}"}</Payload>
        <StatusCode>401</StatusCode>
        <ReasonPhrase>Unauthorized</ReasonPhrase>
    </Set>
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
    <AssignTo createNew="false" transport="http" type="response"/>
</AssignMessage>
`;

const transformOrdersJs = `// Wraps the backend array into an envelope and computes line totals.
var orders = JSON.parse(context.getVariable('response.content'));
var result = orders.map(function (o) {
  return {
    id: o.id,
    customer: o.customer,
    item: o.item,
    quantity: o.quantity,
    total: Math.round(o.quantity * o.price * 100) / 100,
    status: o.status
  };
});
context.setVariable('response.content', JSON.stringify({ count: result.length, orders: result }));
context.setVariable('response.header.X-Order-Count', String(result.length));
print('transformed ' + result.length + ' orders for app ' + context.getVariable('developer.app.name'));
`;

const ordersV1 = {
  'apiproxy/orders-v1.xml': descriptor('orders-v1', 'Orders API v1: API key, spike arrest, product quota, JS transform, CORS and FaultRules', true),
  'apiproxy/proxies/default.xml': `${XML}<ProxyEndpoint name="default">
    <Description>Orders API v1</Description>
    <FaultRules>
        <FaultRule name="invalid-api-key">
${step('AM-InvalidApiKey')}
            <Condition>(fault.name = "InvalidApiKey") or (fault.name = "FailedToResolveAPIKey") or (fault.name = "ApiKeyNotApproved") or (fault.name = "InvalidApiKeyForGivenResource")</Condition>
        </FaultRule>
        <FaultRule name="rate-limited">
${step('AM-TooManyRequests')}
            <Condition>(fault.name = "SpikeArrestViolation") or (fault.name = "QuotaViolation")</Condition>
        </FaultRule>
    </FaultRules>
    <DefaultFaultRule name="default-fault">
${step('AM-AddCORS', null, '        ')}
        <AlwaysEnforce>true</AlwaysEnforce>
    </DefaultFaultRule>
    <PreFlow name="PreFlow">
        <Request>
${step('FC-SecurityBaseline')}
${step('VA-VerifyKey')}
${step('SA-SpikeArrest')}
${step('Q-ProductQuota')}
${step('AM-RemoveApiKey')}
        </Request>
        <Response/>
    </PreFlow>
    <Flows>
        <Flow name="listOrders">
            <Description>GET /orders</Description>
            <Request/>
            <Response>
${step('JS-TransformOrders', null, '                ')}
            </Response>
            <Condition>(proxy.pathsuffix MatchesPath "/orders") and (request.verb = "GET")</Condition>
        </Flow>
        <Flow name="getOrder">
            <Description>GET /orders/{id}</Description>
            <Request>
${step('EV-OrderId', null, '                ')}
            </Request>
            <Response>
${step('AM-SetOrderHeader', null, '                ')}
            </Response>
            <Condition>(proxy.pathsuffix MatchesPath "/orders/*") and (request.verb = "GET")</Condition>
        </Flow>
        <Flow name="createOrder">
            <Description>POST /orders</Description>
            <Request/>
            <Response/>
            <Condition>(proxy.pathsuffix MatchesPath "/orders") and (request.verb = "POST")</Condition>
        </Flow>
        <Flow name="unknownResource">
            <Description>Anything else returns 404</Description>
            <Request>
${step('RF-NotFound', null, '                ')}
            </Request>
            <Response/>
        </Flow>
    </Flows>
    <PostFlow name="PostFlow">
        <Request/>
        <Response>
${step('AM-AddCORS')}
        </Response>
    </PostFlow>
    <PostClientFlow name="PostClientFlow">
        <Response>
${step('ML-AccessLog')}
        </Response>
    </PostClientFlow>
    <HTTPProxyConnection>
        <BasePath>/orders/v1</BasePath>
        <Properties/>
        <VirtualHost>default</VirtualHost>
        <VirtualHost>secure</VirtualHost>
    </HTTPProxyConnection>
    <RouteRule name="default">
        <TargetEndpoint>default</TargetEndpoint>
    </RouteRule>
</ProxyEndpoint>
`,
  'apiproxy/targets/default.xml': mockTarget(''),
  'apiproxy/policies/FC-SecurityBaseline.xml': `${XML}<FlowCallout async="false" continueOnError="false" enabled="true" name="FC-SecurityBaseline">
    <DisplayName>FC-SecurityBaseline</DisplayName>
    <Parameters>
        <Parameter name="security.caller">orders-v1</Parameter>
    </Parameters>
    <SharedFlowBundle>security-baseline</SharedFlowBundle>
</FlowCallout>
`,
  'apiproxy/policies/VA-VerifyKey.xml': verifyKey('request.header.x-api-key'),
  'apiproxy/policies/SA-SpikeArrest.xml': `${XML}<SpikeArrest async="false" continueOnError="false" enabled="true" name="SA-SpikeArrest">
    <DisplayName>SA-SpikeArrest</DisplayName>
    <Identifier ref="client_id"/>
    <Rate>5ps</Rate>
    <UseEffectiveCount>false</UseEffectiveCount>
</SpikeArrest>
`,
  'apiproxy/policies/Q-ProductQuota.xml': `${XML}<Quota async="false" continueOnError="false" enabled="true" name="Q-ProductQuota" type="calendar">
    <DisplayName>Q-ProductQuota</DisplayName>
    <Identifier ref="client_id"/>
    <Allow count="10" countRef="verifyapikey.VA-VerifyKey.apiproduct.developer.quota.limit"/>
    <Interval ref="verifyapikey.VA-VerifyKey.apiproduct.developer.quota.interval">1</Interval>
    <TimeUnit ref="verifyapikey.VA-VerifyKey.apiproduct.developer.quota.timeunit">minute</TimeUnit>
    <Distributed>true</Distributed>
    <Synchronous>true</Synchronous>
    <StartTime>2024-01-01 00:00:00</StartTime>
</Quota>
`,
  'apiproxy/policies/AM-RemoveApiKey.xml': `${XML}<AssignMessage async="false" continueOnError="false" enabled="true" name="AM-RemoveApiKey">
    <DisplayName>AM-RemoveApiKey</DisplayName>
    <Remove>
        <Headers>
            <Header name="x-api-key"/>
        </Headers>
    </Remove>
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
    <AssignTo createNew="false" transport="http" type="request"/>
</AssignMessage>
`,
  'apiproxy/policies/EV-OrderId.xml': `${XML}<ExtractVariables async="false" continueOnError="false" enabled="true" name="EV-OrderId">
    <DisplayName>EV-OrderId</DisplayName>
    <Source clearPayload="false">request</Source>
    <URIPath>
        <Pattern ignoreCase="true">/orders/{id}</Pattern>
    </URIPath>
    <VariablePrefix>order</VariablePrefix>
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
</ExtractVariables>
`,
  'apiproxy/policies/AM-SetOrderHeader.xml': `${XML}<AssignMessage async="false" continueOnError="false" enabled="true" name="AM-SetOrderHeader">
    <DisplayName>AM-SetOrderHeader</DisplayName>
    <Set>
        <Headers>
            <Header name="X-Order-Id">{order.id}</Header>
        </Headers>
    </Set>
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
    <AssignTo createNew="false" transport="http" type="response"/>
</AssignMessage>
`,
  'apiproxy/policies/JS-TransformOrders.xml': `${XML}<Javascript async="false" continueOnError="false" enabled="true" timeLimit="200" name="JS-TransformOrders">
    <DisplayName>JS-TransformOrders</DisplayName>
    <Properties/>
    <ResourceURL>jsc://transform-orders.js</ResourceURL>
</Javascript>
`,
  'apiproxy/policies/RF-NotFound.xml': `${XML}<RaiseFault async="false" continueOnError="false" enabled="true" name="RF-NotFound">
    <DisplayName>RF-NotFound</DisplayName>
    <FaultResponse>
        <Set>
            <Headers/>
            <Payload contentType="application/json">{"error":"not_found","message":"Resource {proxy.pathsuffix} with verb {request.verb} does not exist"}</Payload>
            <StatusCode>404</StatusCode>
            <ReasonPhrase>Not Found</ReasonPhrase>
        </Set>
    </FaultResponse>
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
</RaiseFault>
`,
  'apiproxy/policies/AM-AddCORS.xml': corsPolicy,
  'apiproxy/policies/AM-InvalidApiKey.xml': invalidKeyResponse,
  'apiproxy/policies/AM-TooManyRequests.xml': `${XML}<AssignMessage async="false" continueOnError="false" enabled="true" name="AM-TooManyRequests">
    <DisplayName>AM-TooManyRequests</DisplayName>
    <Set>
        <Headers>
            <Header name="Retry-After">1</Header>
        </Headers>
        <Payload contentType="application/json">{"error":"too_many_requests","fault":"{fault.name}","message":"Slow down"}</Payload>
        <StatusCode>429</StatusCode>
        <ReasonPhrase>Too Many Requests</ReasonPhrase>
    </Set>
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
    <AssignTo createNew="false" transport="http" type="response"/>
</AssignMessage>
`,
  'apiproxy/policies/ML-AccessLog.xml': `${XML}<MessageLogging async="false" continueOnError="false" enabled="true" name="ML-AccessLog">
    <DisplayName>ML-AccessLog</DisplayName>
    <Syslog>
        <Message>[orders-v1] {request.verb} {proxy.pathsuffix} app={developer.app.name} status={response.status.code} messageid={messageid}</Message>
    </Syslog>
</MessageLogging>
`,
  'apiproxy/resources/jsc/transform-orders.js': transformOrdersJs,
};

// broken-orders: same idea as orders-v1 but with intentional bugs (see PRACTICE.md, Exercise 2).
const brokenOrders = {
  'apiproxy/broken-orders.xml': descriptor('broken-orders', 'Intentionally broken copy of the Orders API. Find and fix the bugs using Trace.', true),
  'apiproxy/proxies/default.xml': `${XML}<ProxyEndpoint name="default">
    <Description>Broken Orders API (debugging exercise)</Description>
    <FaultRules>
        <FaultRule name="invalid-api-key">
${step('AM-InvalidApiKey')}
            <Condition>fault.name = "InvalidAPIKey"</Condition>
        </FaultRule>
    </FaultRules>
    <PreFlow name="PreFlow">
        <Request>
${step('VA-VerifyKey')}
        </Request>
        <Response/>
    </PreFlow>
    <Flows>
        <Flow name="listOrders">
            <Request/>
            <Response>
${step('JS-TransformOrders', null, '                ')}
            </Response>
            <Condition>(proxy.pathsuffix MatchesPath "/orders/*") and (request.verb = "GET")</Condition>
        </Flow>
    </Flows>
    <PostFlow name="PostFlow">
        <Request>
${step('AM-AddCORS')}
        </Request>
        <Response/>
    </PostFlow>
    <HTTPProxyConnection>
        <BasePath>/broken-orders/v1</BasePath>
        <Properties/>
        <VirtualHost>default</VirtualHost>
    </HTTPProxyConnection>
    <RouteRule name="default">
        <TargetEndpoint>default</TargetEndpoint>
    </RouteRule>
</ProxyEndpoint>
`,
  'apiproxy/targets/default.xml': mockTarget('/v1', 'Mock backend (check the Path!)'),
  'apiproxy/policies/VA-VerifyKey.xml': verifyKey('request.queryparam.api-key'),
  'apiproxy/policies/AM-InvalidApiKey.xml': invalidKeyResponse,
  'apiproxy/policies/AM-AddCORS.xml': corsPolicy,
  'apiproxy/policies/JS-TransformOrders.xml': ordersV1['apiproxy/policies/JS-TransformOrders.xml'],
  'apiproxy/resources/jsc/transform-orders.js': transformOrdersJs,
};

const oauth = {
  'apiproxy/oauth.xml': descriptor('oauth', 'OAuth 2.0 client_credentials token endpoint plus a protected resource', false),
  'apiproxy/proxies/default.xml': `${XML}<ProxyEndpoint name="default">
    <Description>OAuth token endpoint</Description>
    <FaultRules/>
    <PreFlow name="PreFlow">
        <Request/>
        <Response/>
    </PreFlow>
    <Flows>
        <Flow name="token">
            <Description>POST /token (grant_type=client_credentials, Basic auth with consumer key/secret)</Description>
            <Request>
${step('OA-GenerateToken', null, '                ')}
            </Request>
            <Response/>
            <Condition>(proxy.pathsuffix MatchesPath "/token") and (request.verb = "POST")</Condition>
        </Flow>
        <Flow name="protected">
            <Description>GET /protected with Authorization: Bearer {token}</Description>
            <Request>
${step('OA-VerifyToken', null, '                ')}
${step('AM-ProtectedResponse', null, '                ')}
            </Request>
            <Response/>
            <Condition>(proxy.pathsuffix MatchesPath "/protected") and (request.verb = "GET")</Condition>
        </Flow>
        <Flow name="unknownResource">
            <Request>
${step('RF-NotFound', null, '                ')}
            </Request>
            <Response/>
        </Flow>
    </Flows>
    <PostFlow name="PostFlow">
        <Request/>
        <Response/>
    </PostFlow>
    <HTTPProxyConnection>
        <BasePath>/oauth</BasePath>
        <Properties/>
        <VirtualHost>default</VirtualHost>
        <VirtualHost>secure</VirtualHost>
    </HTTPProxyConnection>
    <RouteRule name="noroute"/>
</ProxyEndpoint>
`,
  'apiproxy/policies/OA-GenerateToken.xml': `${XML}<OAuthV2 async="false" continueOnError="false" enabled="true" name="OA-GenerateToken">
    <DisplayName>OA-GenerateToken</DisplayName>
    <Operation>GenerateAccessToken</Operation>
    <ExpiresIn>1800000</ExpiresIn>
    <SupportedGrantTypes>
        <GrantType>client_credentials</GrantType>
    </SupportedGrantTypes>
    <GrantType>request.formparam.grant_type</GrantType>
    <Scope>request.formparam.scope</Scope>
    <GenerateResponse enabled="true"/>
</OAuthV2>
`,
  'apiproxy/policies/OA-VerifyToken.xml': `${XML}<OAuthV2 async="false" continueOnError="false" enabled="true" name="OA-VerifyToken">
    <DisplayName>OA-VerifyToken</DisplayName>
    <Operation>VerifyAccessToken</Operation>
</OAuthV2>
`,
  'apiproxy/policies/AM-ProtectedResponse.xml': `${XML}<AssignMessage async="false" continueOnError="false" enabled="true" name="AM-ProtectedResponse">
    <DisplayName>AM-ProtectedResponse</DisplayName>
    <Set>
        <Payload contentType="application/json">{"message":"Access granted","client_id":"{client_id}","app":"{developer.app.name}","scope":"{scope}","expires_in":"{expires_in}"}</Payload>
        <StatusCode>200</StatusCode>
    </Set>
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
    <AssignTo createNew="false" transport="http" type="response"/>
</AssignMessage>
`,
  'apiproxy/policies/RF-NotFound.xml': ordersV1['apiproxy/policies/RF-NotFound.xml'],
};

const helloWorld = {
  'apiproxy/hello-world.xml': descriptor('hello-world', 'No-target proxy that answers with AssignMessage', false),
  'apiproxy/proxies/default.xml': `${XML}<ProxyEndpoint name="default">
    <Description>Hello world</Description>
    <FaultRules/>
    <PreFlow name="PreFlow">
        <Request>
${step('AM-Hello')}
        </Request>
        <Response/>
    </PreFlow>
    <PostFlow name="PostFlow">
        <Request/>
        <Response/>
    </PostFlow>
    <Flows/>
    <HTTPProxyConnection>
        <BasePath>/hello</BasePath>
        <Properties/>
        <VirtualHost>default</VirtualHost>
        <VirtualHost>secure</VirtualHost>
    </HTTPProxyConnection>
    <RouteRule name="noroute"/>
</ProxyEndpoint>
`,
  'apiproxy/policies/AM-Hello.xml': `${XML}<AssignMessage async="false" continueOnError="false" enabled="true" name="AM-Hello">
    <DisplayName>AM-Hello</DisplayName>
    <Set>
        <Headers>
            <Header name="X-Powered-By">Apigee Lite</Header>
        </Headers>
        <Payload contentType="application/json">{"message":"Hello, World!","proxy":"{apiproxy.name}","pathsuffix":"{proxy.pathsuffix}","messageid":"{messageid}"}</Payload>
        <StatusCode>200</StatusCode>
    </Set>
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
    <AssignTo createNew="false" transport="http" type="response"/>
</AssignMessage>
`,
};

const securityBaseline = {
  'sharedflowbundle/security-baseline.xml': `${XML}<SharedFlowBundle revision="1" name="security-baseline">
    <DisplayName>security-baseline</DisplayName>
    <Description>Common request hardening: JSON threat protection and a marker header</Description>
    <SharedFlows>
        <SharedFlow>default</SharedFlow>
    </SharedFlows>
</SharedFlowBundle>
`,
  'sharedflowbundle/sharedflows/default.xml': `${XML}<SharedFlow name="default">
${step('JTP-JsonThreat', '(request.verb = "POST") or (request.verb = "PUT")', '    ')}
${step('AM-MarkRequest', null, '    ')}
</SharedFlow>
`,
  'sharedflowbundle/policies/JTP-JsonThreat.xml': `${XML}<JSONThreatProtection async="false" continueOnError="false" enabled="true" name="JTP-JsonThreat">
    <DisplayName>JTP-JsonThreat</DisplayName>
    <ArrayElementCount>20</ArrayElementCount>
    <ContainerDepth>5</ContainerDepth>
    <ObjectEntryCount>15</ObjectEntryCount>
    <ObjectEntryNameLength>50</ObjectEntryNameLength>
    <Source>request</Source>
    <StringValueLength>500</StringValueLength>
</JSONThreatProtection>
`,
  'sharedflowbundle/policies/AM-MarkRequest.xml': `${XML}<AssignMessage async="false" continueOnError="false" enabled="true" name="AM-MarkRequest">
    <DisplayName>AM-MarkRequest</DisplayName>
    <Set>
        <Headers>
            <Header name="X-Security-Baseline">applied-by-{security.caller}</Header>
        </Headers>
    </Set>
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
    <AssignTo createNew="false" transport="http" type="request"/>
</AssignMessage>
`,
};

module.exports = {
  apis: { 'orders-v1': ordersV1, 'broken-orders': brokenOrders, oauth, 'hello-world': helloWorld },
  sharedflows: { 'security-baseline': securityBaseline },
};
