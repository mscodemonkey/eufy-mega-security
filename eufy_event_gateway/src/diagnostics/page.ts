/**
 * Renders the local diagnostics workflow for every gateway device family.
 * GatewayServer serves this static page. Its browser script keeps the bearer
 * token in memory, uses authenticated API calls, and owns any optional live
 * viewer until stop, expiry or page departure. Nothing is uploaded automatically.
 */

/** Build the diagnostics page without inserting inventory or credentials into HTML. */
export function diagnosticsPage(): string {
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Eufy diagnostics</title>
<style>body{font:17px system-ui;max-width:680px;margin:40px auto;padding:0 20px;color:#243244}label{display:block;margin:20px 0}input,select,button{font:inherit;padding:9px}input[type=password]{width:90%}button{margin:6px 8px 6px 0}pre{white-space:pre-wrap;background:#f2f4f7;padding:16px}small{display:block;margin-top:7px;color:#526070}</style>
<h1>Create a diagnostic bundle</h1>
<p>For Home Assistant app installs, the support utility can use your saved integration connection without copying a token. See the private diagnostics guide in the project documentation.</p>
<p>Select a device, start a short session and reproduce the problem in Home Assistant or the Eufy app. HomeBases, standalone cameras, sensors and other discovered devices use the same workflow.</p>
<label>Gateway API token <input id="token" type="password" autocomplete="off" spellcheck="false"></label>
<button id="load">Load devices</button>
<label>Device <select id="device"><option value="">All devices</option></select></label>
<details id="trials"><summary>Experimental model controls</summary>
<p>Enable experimental model controls in the app settings, then select a camera. These controls need testing on your hardware. Stop live view first. Remember the original setting and restore it after testing.</p>
<button id="trial-load">Check available controls</button>
<label>Control <select id="trial-action"></select></label>
<label>Value <select id="trial-value"><option value="true">On</option><option value="false">Off</option><option value="left">Left</option><option value="right">Right</option><option value="up">Up</option><option value="down">Down</option></select></label>
<label><input id="trial-consent" type="checkbox"> I am ready to observe the camera and restore its setting.</label>
<button id="trial-send">Try once</button>
<pre id="trial-status" role="status">No control trial started.</pre></details>
<label>Capture duration <select id="seconds"><option value="30">30 seconds</option><option value="60">60 seconds</option></select></label>
<label><input id="media" type="checkbox"> Include private pictures, audio and video. I agree to capture and share this evidence privately.
<small>Leave this unchecked for discovery, controls or event delivery problems. Media can reveal people, conversations and your surroundings.</small></label>
<label><input id="live" type="checkbox"> Open the selected camera's live stream during capture.
<small>Choose one camera and include private media. This uses the gateway's existing stream support. Unsupported streams remain unavailable.</small></label>
<button id="start">Start capture</button><button id="stop">Stop</button><button id="download">Download bundle</button><button id="clear">Clear evidence</button>
<pre id="status" role="status">Enter your gateway API token to begin.</pre>
<p>Send the downloaded file to <a href="mailto:mscm.projects@gmail.com">mscm.projects@gmail.com</a> with your issue number and what you tried. Files over 20 MB are best shared with a private cloud link granting that address download access. Keep media and private links out of public GitHub issues.</p>
<p>Evidence is held in gateway memory for up to 10 minutes. Download stops capture. Clear evidence erases the session. A gateway restart also erases it.</p>
<script>
const el = id => document.getElementById(id);
let targets = [], stream = null, poll = null;
const show = value => { el('status').textContent = value; };
const abortStream = () => { if(stream) stream.abort(); stream = null; };
async function api(path, method = 'GET', body) {
  const headers = { Authorization: 'Bearer ' + el('token').value };
  if(body !== undefined) headers['Content-Type'] = 'application/json';
  const result = await fetch('api/diagnostics/' + path, { method, headers, cache: 'no-store', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if(!result.ok) throw Error('Gateway returned HTTP ' + result.status + '. Check your token, selection and capture status.');
  return result;
}
async function status() {
  const value = await (await api('bundle')).json();
  show(JSON.stringify(value, null, 2));
  if(value.state !== 'active') { abortStream(); clearInterval(poll); poll = null; }
}
function action(id, fn) { el(id).onclick = async () => { try { await fn(); } catch(error) { show(error.message); } }; }
action('load', async () => {
  targets = (await (await api('bundle/targets')).json()).devices;
  el('device').replaceChildren(new Option('All devices', ''));
  for(const target of targets) el('device').add(new Option(target.name + ' (' + target.model + ')', target.serial));
  await status();
});
async function trialApi(method, body) {
  const serial = el('device').value;
  if(!serial) throw Error('Select one camera first.');
  const result = await fetch('api/cameras/' + encodeURIComponent(serial) + '/model-control-trial', {
    method, headers: { Authorization: 'Bearer ' + el('token').value, 'Content-Type': 'application/json' },
    cache: 'no-store', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await result.json();
  if(!result.ok) throw Error(value.error || 'Control trial failed. Check the camera before retrying.');
  return value;
}
action('trial-load', async () => {
  const value = await trialApi('GET');
  el('trial-action').replaceChildren();
  for(const name of value.actions) el('trial-action').add(new Option(name, name));
  el('trial-status').textContent = value.actions.length ? 'Choose one control and observe the camera.' : 'No exact model control trials available.';
});
action('trial-send', async () => {
  if(!el('trial-consent').checked) throw Error('Confirm you are ready to observe and restore the camera.');
  const action = el('trial-action').value, value = el('trial-value').value;
  if(action === 'ptz' ? !['left','right','up','down'].includes(value) : !['true','false'].includes(value)) throw Error('Choose a value matching the control.');
  el('trial-send').disabled = true;
  el('trial-status').textContent = 'Trying once. Do not retry until the result is known.';
  try {
    const result = await trialApi('POST', action === 'ptz' ? { action, direction: value } : { action, enabled: value === 'true' });
    el('trial-status').textContent = result.outcome === 'acknowledged' ? 'Command acknowledged. Check whether the camera moved.'
      : result.outcome === 'unchanged' ? 'Camera already reports this setting. No command sent.' : 'Camera reports the requested setting. Check its behaviour and restore the original setting when finished.';
  } catch(error) { el('trial-status').textContent = error.message + ' Check the camera before retrying.'; }
  finally { el('trial-send').disabled = false; }
});
action('start', async () => {
  const target = el('device').value || null;
  const media = el('media').checked;
  const live = el('live').checked;
  if(live && (!media || !targets.some(row => row.serial === target && row.streamSupported))) throw Error('Live capture needs private-media consent and one camera with gateway stream support.');
  abortStream();
  await api('bundle', 'POST', { target, seconds: Number(el('seconds').value), media, consentPrivateMedia: media });
  await status();
  if(poll) clearInterval(poll);
  poll = setInterval(() => status().catch(() => { abortStream(); clearInterval(poll); show('Status unavailable. Capture still has its gateway time limit.'); }), 1000);
  if(live) {
    stream = new AbortController();
    const controller = stream;
    fetch('api/cameras/' + encodeURIComponent(target) + '/live.h264', { headers: { Authorization: 'Bearer ' + el('token').value }, signal: controller.signal, cache: 'no-store' })
      .then(async result => {
        if(!result.ok) throw Error('Live stream unavailable, HTTP ' + result.status);
        const reader = result.body.getReader();
        while(!(await reader.read()).done) {}
      }).catch(error => { if(!controller.signal.aborted) show(error.message + '. Metadata remains captured.'); });
  }
});
action('stop', async () => { abortStream(); await api('bundle/stop', 'POST'); await status(); });
action('clear', async () => { abortStream(); await api('bundle', 'DELETE'); await status(); });
action('download', async () => {
  abortStream();
  const result = await api('bundle/export', 'POST');
  const blob = await result.blob();
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = 'eufy-diagnostics.json.gz'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  await status();
  show('Downloaded ' + (blob.size / 1000000).toFixed(1) + ' MB. ' + (blob.size > 20000000 ? 'Use a private cloud link.' : 'Email attachment or a private cloud link is fine.'));
});
window.addEventListener('pagehide', abortStream);
</script></html>`;
}
