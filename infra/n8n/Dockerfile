# n8n with lifeline-core available to Code nodes.
# Pin N8N_VERSION to a tested tag before the demo.
ARG N8N_VERSION=latest
FROM n8nio/n8n:${N8N_VERSION}

# lifeline-core has zero runtime dependencies, so copying it into n8n's
# node_modules is enough. No npm install is needed (some n8n images ship without npm).
# Code nodes (and the task runner, which resolves modules from n8n's tree)
# can then require('lifeline-core'), given NODE_FUNCTION_ALLOW_EXTERNAL=lifeline-core.
USER root
COPY core/package.json /usr/local/lib/node_modules/n8n/node_modules/lifeline-core/package.json
COPY core/src          /usr/local/lib/node_modules/n8n/node_modules/lifeline-core/src
COPY core/config       /usr/local/lib/node_modules/n8n/node_modules/lifeline-core/config
# Versioned LLM prompts; core/src/llm.js looks for them next to src/.
COPY n8n/prompts       /usr/local/lib/node_modules/n8n/node_modules/lifeline-core/prompts
USER node
