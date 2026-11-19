const body = document.getElementById('page-body');
const statusIndicator = document.getElementById('status-indicator');
const metaEndpoint = document.getElementById('meta-endpoint');
const metaStatus = document.getElementById('meta-status');
const metaRequestId = document.getElementById('meta-request-id');
const responseOutput = document.getElementById('response-output');

async function triggerAction(endpoint, expectedColor) {
  statusIndicator.className = 'status-indicator idle';
  statusIndicator.textContent = `Sending request to ${endpoint}...`;
  metaEndpoint.textContent = endpoint;
  metaStatus.textContent = 'In flight...';
  metaRequestId.textContent = 'Waiting...';

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    const data = await res.json().catch(() => ({ raw: 'Non-JSON response' }));
    const requestId = res.headers.get('X-Request-Id') || data.request_id || 'unknown';

    metaStatus.textContent = `${res.status} ${res.statusText}`;
    metaRequestId.textContent = requestId;
    responseOutput.textContent = JSON.stringify(data, null, 2);

    if (res.ok) {
      statusIndicator.className = 'status-indicator success';
      statusIndicator.textContent = `Success: HTTP ${res.status} returned from ${endpoint}`;
      
      // Change color ONLY on success
      if (expectedColor === 'red') {
        body.className = 'color-red';
      } else if (expectedColor === 'blue') {
        body.className = 'color-blue';
      }
    } else {
      // Intentional failure: DO NOT change color
      statusIndicator.className = 'status-indicator error';
      statusIndicator.textContent = `Failure captured: HTTP ${res.status} returned from ${endpoint}. PM2 error log updated.`;
    }
  } catch (err) {
    statusIndicator.className = 'status-indicator error';
    statusIndicator.textContent = `Network error: ${err.message}`;
    metaStatus.textContent = 'Network Error';
    responseOutput.textContent = err.stack || err.message;
  }
}

document.getElementById('btn-success-red').addEventListener('click', () => {
  triggerAction('/api/success-red', 'red');
});

document.getElementById('btn-success-blue').addEventListener('click', () => {
  triggerAction('/api/success-blue', 'blue');
});

document.getElementById('btn-fail-one').addEventListener('click', () => {
  triggerAction('/api/fail-one', null);
});

document.getElementById('btn-fail-two').addEventListener('click', () => {
  triggerAction('/api/fail-two', null);
});

document.getElementById('btn-reset-color').addEventListener('click', () => {
  body.className = '';
  statusIndicator.className = 'status-indicator idle';
  statusIndicator.textContent = 'Background color reset to default.';
});
