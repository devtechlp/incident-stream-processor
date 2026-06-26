const axios = require('axios');
const logger = require('../utils/logger');

const {
  JIRA_BASE_URL,
  JIRA_EMAIL,
  JIRA_API_TOKEN,
  JIRA_PROJECT_KEY,
  JIRA_INCIDENT_ISSUETYPE_ID,
  JIRA_SERVICE_NAME_FIELD_ID,
  JIRA_SERVICE_DESK_ID,
  JIRA_REQUEST_TYPE_ID,
} = process.env;

const REQUIRED_ENV = [
  'JIRA_BASE_URL',
  'JIRA_EMAIL',
  'JIRA_API_TOKEN',
  'JIRA_SERVICE_NAME_FIELD_ID',
];

function usesCustomerRequestApi() {
  return Boolean(JIRA_SERVICE_DESK_ID?.trim() && JIRA_REQUEST_TYPE_ID?.trim());
}

function assertJiraConfigured() {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]?.trim());
  if (missing.length) {
    throw new Error(
      `Jira destination requires env vars: ${missing.join(', ')}. ` +
        'Set them on incident-stream-processor or use destination "mongo".'
    );
  }

  if (!usesCustomerRequestApi()) {
    const legacyMissing = ['JIRA_PROJECT_KEY', 'JIRA_INCIDENT_ISSUETYPE_ID'].filter(
      (name) => !process.env[name]?.trim()
    );
    if (legacyMissing.length) {
      throw new Error(
        `Jira destination requires ${legacyMissing.join(', ')} when ` +
          'JIRA_SERVICE_DESK_ID / JIRA_REQUEST_TYPE_ID are not set. ' +
          'Set desk + request type IDs to create portal-visible customer requests.'
      );
    }
  }
}

function authHeader() {
  const token = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
  return `Basic ${token}`;
}

const issueClient = axios.create({
  baseURL: `${JIRA_BASE_URL}/rest/api/3`,
  headers: {
    Authorization: undefined,
    Accept: 'application/json',
  },
});

issueClient.interceptors.request.use((config) => {
  config.headers.Authorization = authHeader();
  return config;
});

function textToAdf(text) {
  return {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: text || '' }],
      },
    ],
  };
}

function jiraServiceNameValue(serviceName) {
  if (!serviceName) return undefined;
  const key = String(serviceName).trim().toLowerCase();
  const displayValues = {
    admin: 'Admin',
    transaction: 'Transaction',
    invoice: 'Invoice',
  };
  return displayValues[key] || key.charAt(0).toUpperCase() + key.slice(1);
}

async function applyLabels(issueKey, labels) {
  if (!labels?.length) return;
  await issueClient.put(`/issue/${issueKey}`, {
    fields: { labels },
  });
}

/**
 * Creates a JSM customer request so the issue appears in the portal queue
 * with the configured request type (e.g. "Report an Issue").
 */
async function createCustomerRequest({ title, description, serviceName, severity, labels }) {
  const serviceFieldId = JIRA_SERVICE_NAME_FIELD_ID;
  const requestFieldValues = {
    summary: title,
    description,
  };

  if (serviceName && serviceFieldId) {
    requestFieldValues[serviceFieldId] = { value: jiraServiceNameValue(serviceName) };
  }

  if (severity) {
    requestFieldValues.priority = { name: severity };
  }

  const { data } = await axios.post(
    `${JIRA_BASE_URL}/rest/servicedeskapi/request`,
    {
      serviceDeskId: String(JIRA_SERVICE_DESK_ID).trim(),
      requestTypeId: String(JIRA_REQUEST_TYPE_ID).trim(),
      requestFieldValues,
    },
    {
      headers: {
        Authorization: authHeader(),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    }
  );

  const issueKey = data.issueKey;
  logger.info('Created JSM customer request', {
    issueKey,
    requestTypeId: JIRA_REQUEST_TYPE_ID,
    serviceDeskId: JIRA_SERVICE_DESK_ID,
  });

  await applyLabels(issueKey, labels);
  return issueKey;
}

async function createIssueViaRestApi({ title, description, serviceName, severity, labels }) {
  const payload = {
    fields: {
      project: { key: JIRA_PROJECT_KEY },
      issuetype: { id: JIRA_INCIDENT_ISSUETYPE_ID },
      summary: title,
      description: textToAdf(description),
      labels: labels && labels.length ? labels : undefined,
      [JIRA_SERVICE_NAME_FIELD_ID]: serviceName
        ? { value: jiraServiceNameValue(serviceName) }
        : undefined,
    },
  };

  if (severity) {
    payload.fields.priority = { name: severity };
  }

  const { data } = await issueClient.post('/issue', payload);
  logger.info('Created Jira incident issue (REST API — not a portal customer request)', {
    issueKey: data.key,
  });
  return data.key;
}

async function createIncidentIssue({ title, description, serviceName, severity, labels }) {
  assertJiraConfigured();

  if (usesCustomerRequestApi()) {
    return createCustomerRequest({ title, description, serviceName, severity, labels });
  }

  return createIssueViaRestApi({ title, description, serviceName, severity, labels });
}

module.exports = {
  assertJiraConfigured,
  createIncidentIssue,
  createCustomerRequest,
  jiraServiceNameValue,
  textToAdf,
  usesCustomerRequestApi,
};
