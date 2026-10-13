'use strict';
const { escapeXml } = require('../runtime/xml');

function proxyEndpointXml({ basePath, hasTarget }) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ProxyEndpoint name="default">
    <Description/>
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
    <HTTPProxyConnection>
        <BasePath>${escapeXml(basePath)}</BasePath>
        <Properties/>
        <VirtualHost>default</VirtualHost>
        <VirtualHost>secure</VirtualHost>
    </HTTPProxyConnection>
${hasTarget ? `    <RouteRule name="default">
        <TargetEndpoint>default</TargetEndpoint>
    </RouteRule>` : '    <RouteRule name="noroute"/>'}
</ProxyEndpoint>
`;
}

function targetEndpointXml({ targetType, targetUrl, targetPath }) {
  const conn = targetType === 'mock'
    ? `    <HTTPTargetConnection>
        <LoadBalancer>
            <Server name="mock-backend"/>
        </LoadBalancer>
        <Path>${escapeXml(targetPath || '')}</Path>
        <Properties/>
    </HTTPTargetConnection>`
    : `    <HTTPTargetConnection>
        <Properties/>
        <URL>${escapeXml(targetUrl)}</URL>
    </HTTPTargetConnection>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<TargetEndpoint name="default">
    <Description/>
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
${conn}
</TargetEndpoint>
`;
}

function newProxyFiles({ name, basePath, targetType = 'none', targetUrl, targetPath, description = '' }) {
  const hasTarget = targetType === 'url' || targetType === 'mock';
  const files = {
    [`apiproxy/${name}.xml`]: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<APIProxy revision="1" name="${escapeXml(name)}">
    <DisplayName>${escapeXml(name)}</DisplayName>
    <Description>${escapeXml(description)}</Description>
    <ProxyEndpoints>
        <ProxyEndpoint>default</ProxyEndpoint>
    </ProxyEndpoints>
${hasTarget ? '    <TargetEndpoints>\n        <TargetEndpoint>default</TargetEndpoint>\n    </TargetEndpoints>\n' : ''}</APIProxy>
`,
    'apiproxy/proxies/default.xml': proxyEndpointXml({ basePath, hasTarget }),
  };
  if (hasTarget) files['apiproxy/targets/default.xml'] = targetEndpointXml({ targetType, targetUrl, targetPath });
  return files;
}

function newSharedFlowFiles({ name, description = '' }) {
  return {
    [`sharedflowbundle/${name}.xml`]: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<SharedFlowBundle revision="1" name="${escapeXml(name)}">
    <DisplayName>${escapeXml(name)}</DisplayName>
    <Description>${escapeXml(description)}</Description>
    <SharedFlows>
        <SharedFlow>default</SharedFlow>
    </SharedFlows>
</SharedFlowBundle>
`,
    'sharedflowbundle/sharedflows/default.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<SharedFlow name="default">
</SharedFlow>
`,
  };
}

module.exports = { newProxyFiles, newSharedFlowFiles };
