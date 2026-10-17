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
<label><input id="trial-consent" type="checkbox"> I am ready to observe the camera, stop the siren if needed and restore changed settings.</label>
<button id="trial-send">Try once</button><button id="trial-siren-stop" hidden>Stop siren</button>
<p id="trial-help"></p>
<pre id="trial-status" role="status">No control trial started.</pre></details>
<details><summary>Experimental NVR video test</summary>
<p>Enable experimental NVR live video in the app options. This test is for T8E00, T8140, T8140-Z, T8113-V, T8172, T8162, T8170, T81A0 and T8425 cameras through T8N00 or T9000. Additional models use their first lens, and hardware behaviour is unconfirmed. Stop other live viewers first. For GB-style accounts the service region may need to be ie.</p>
<label><input id="nvr-consent" type="checkbox"> I agree to request a ten-second private video clip from the selected camera.</label>
<button id="nvr-test">Try NVR video once</button><button id="nvr-stop">Cancel NVR test</button>
<label><input id="nvr-state-consent" type="checkbox"> I agree to connect once and read the selected camera and NVR settings without changing them.</label>
<button id="nvr-state-test">Read NVR state once</button>
<p>Compare the displayed settings with the Eufy app. Unknown values stay unknown. This test does not enable arming or camera controls.</p>
<pre id="nvr-status" role="status">No NVR video test started.</pre>
<video id="nvr-video" controls hidden style="max-width:100%"></video>
<a id="nvr-download" hidden download="eufy-nvr-test.mp4">Download private test clip</a>
<p>The clip stays in this browser and is never uploaded automatically. HEVC may require a compatible player. If the picture does not play, keep the clip private and share only the nvr_live_trial_failed log line publicly.</p></details>
<details><summary>Experimental standalone doorbell video test</summary>
<p>Enable this test in the app options first, then select one standalone Video Doorbell C30. Stop other viewers before testing. Normal Home Assistant live view stays unchanged.</p>
<label><input id="doorbell-consent" type="checkbox"> I agree to request a ten-second private video clip from the selected doorbell.</label>
<button id="doorbell-test">Try doorbell video once</button><button id="doorbell-stop">Cancel doorbell test</button>
<pre id="doorbell-status" role="status">No doorbell video test started.</pre>
<video id="doorbell-video" controls hidden style="max-width:100%"></video>
<a id="doorbell-download" hidden download="eufy-doorbell-test.mp4">Download private test clip</a>
<p>The clip stays in this browser and is never uploaded automatically. Keep it private. If the test fails, share only the doorbell_rtc_trial_failed log line.</p></details>
<details><summary>Experimental T8910 local motion test</summary>
<p>Enable experimental model controls, then select one T8910 motion sensor connected to HomeBase 2 or 3. This listens for 45 seconds without changing sensor settings. Keep your current phone notification and security settings. Walk past the sensor while the test runs.</p>
<p>We have not confirmed local delivery on hardware. This test does not add phone-independent Home Assistant motion yet. It checks cloud device information and may contact Eufy to find the HomeBase. Its connection may briefly compete with viewing in the Eufy app. Close live viewers first.</p>
<label><input id="motion-consent" type="checkbox"> I agree to a brief local-motion test with my existing settings.</label>
<button id="motion-start">Listen for local motion</button><button id="motion-cancel">Cancel motion test</button>
<pre id="motion-status" role="status">No local motion test started. No observations is inconclusive.</pre></details>
<details><summary>Experimental C31 continuous-recording index test</summary>
<p>Enable experimental model controls first, then select a standalone C31. Use this only if the camera already has continuous recordings. Stop its live viewers first. This experimental test asks the camera for its recent recording periods. We have not confirmed its behaviour on hardware. It sends no commands to change recording settings or download footage.</p>
<label><input id="index-consent" type="checkbox"> I agree to one experimental index query for the last thirty minutes. I understand that hardware behaviour is unconfirmed.</label>
<button id="index-start">Check recording index once</button><button id="index-cancel">Cancel index test</button>
<pre id="index-status" role="status">No index test started. A timeout is inconclusive.</pre></details>
<details><summary>Experimental cloud recording preview</summary>
<p>Enable this test in the app options first. Select one camera and a day, then choose an existing cloud recording. This does not list local HomeBase recordings or change your subscription.</p>
<label>Recording day <input id="cloud-date" type="date"></label><button id="cloud-list">Load cloud recordings</button>
<label>Recording <select id="cloud-record"><option value="">Load a day first</option></select></label>
<label><input id="cloud-consent" type="checkbox"> I agree to download and process the selected private recording for a video-only preview.</label>
<button id="cloud-test">Preview selected recording</button><button id="cloud-stop">Cancel cloud test</button>
<pre id="cloud-status" role="status">No cloud recording selected.</pre>
<video id="cloud-video" controls hidden style="max-width:100%"></video>
<a id="cloud-download" hidden download="eufy-cloud-preview.mp4">Download private preview</a>
<p>The preview has no audio and is limited to two minutes. Some older recording formats are unavailable. It stays in this browser and is never uploaded automatically. Keep footage private. If it fails, share only the cloud_recording_trial_failed log line.</p></details>
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
let targets = [], stream = null, poll = null, activeTrialSerial = null, nvrJob = null, nvrClip = null, doorbellJob = null, doorbellClip = null;
let indexJob = null, motionJob = null;
let cloudJob = null, cloudLoadJob = null, cloudClip = null, cloudSelection = null, cloudGeneration = 0;
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
async function trialApi(method, body, serial = el('device').value) {
  if(!serial) throw Error('Select one camera first.');
  const result = await fetch('api/cameras/' + encodeURIComponent(serial) + '/model-control-trial', {
    method, headers: { Authorization: 'Bearer ' + el('token').value, 'Content-Type': 'application/json' },
    cache: 'no-store', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await result.json();
  if(!result.ok) throw Error(value.error || 'Control trial failed. Check the camera before retrying.');
  return value;
}
function trialValues() {
  const action = el('trial-action').value;
  el('trial-value').replaceChildren();
  const values = action === 'ptz' ? [['left','Left'],['right','Right'],['up','Up'],['down','Down']]
    : action === 'siren' ? [['true','Five-second sound test'],['false','Stop siren']] : [['true','On'],['false','Off']];
  for(const pair of values) el('trial-value').add(new Option(pair[1], pair[0]));
  el('trial-siren-stop').hidden = action !== 'siren';
  el('trial-help').textContent = action === 'siren' ? 'Listen and be ready to stop the siren. The start command requests a 30-second limit, but device enforcement is unverified. If it keeps sounding, stop it in the Eufy app.' : '';
}
el('trial-action').onchange = trialValues;
action('trial-siren-stop', async () => {
  await trialApi('POST', { action: 'siren', enabled: false }, activeTrialSerial || el('device').value);
  el('trial-status').textContent = 'Stop commands acknowledged. Check that the siren is silent.';
});
action('trial-load', async () => {
  const value = await trialApi('GET');
  el('trial-action').replaceChildren();
  for(const name of value.actions) el('trial-action').add(new Option(name, name));
  trialValues();
  el('trial-status').textContent = value.actions.length ? 'Choose one control and observe the camera.' : 'No exact model control trials available.';
});
action('trial-send', async () => {
  if(cloudJob || cloudLoadJob) throw Error('Finish the cloud recording test before trying camera controls.');
  if(!el('trial-consent').checked) throw Error('Confirm you are ready to observe and restore the camera.');
  const action = el('trial-action').value, value = el('trial-value').value;
  if(action === 'ptz' ? !['left','right','up','down'].includes(value) : !['true','false'].includes(value)) throw Error('Choose a value matching the control.');
  el('trial-send').disabled = true;
  activeTrialSerial = el('device').value;
  el('device').disabled = true;
  el('trial-action').disabled = true;
  el('trial-load').disabled = true;
  el('trial-value').disabled = true;
  el('trial-status').textContent = 'Trying once. Do not retry until the result is known.';
  try {
    const result = await trialApi('POST', action === 'ptz' ? { action, direction: value } : { action, enabled: value === 'true' });
    el('trial-status').textContent = action === 'siren' ? 'Commands acknowledged. Did the siren sound and stop? This result does not confirm audible behaviour.' : result.outcome === 'acknowledged' ? 'Command acknowledged. Check whether the camera moved.'
      : result.outcome === 'unchanged' ? 'Camera already reports this setting. No command sent.' : 'Camera reports the requested setting. Check its behaviour and restore the original setting when finished.';
  } catch(error) { el('trial-status').textContent = error.message + ' Check the camera before retrying. If it keeps sounding, stop it in the Eufy app. Send the model_control_trial_failed log line if the test failed.'; }
  finally { el('trial-send').disabled = false; el('device').disabled = false; el('trial-action').disabled = false; el('trial-load').disabled = false; el('trial-value').disabled = false; activeTrialSerial = null; }
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
action('nvr-stop', async () => { if(nvrJob) nvrJob.abort(); });
action('nvr-test', async () => {
  const selected = el('device').value;
  if(!selected || !el('nvr-consent').checked) throw Error('Select one camera and confirm private video consent.');
  if(nvrJob || doorbellJob || cloudJob) return;
  const job = nvrJob = new AbortController();
  el('nvr-test').disabled = true; el('nvr-state-test').disabled = true; el('device').disabled = true;
  el('nvr-status').textContent = 'Connecting and requesting a ten-second clip. This may take up to 90 seconds.';
  try {
    const result = await fetch('api/cameras/' + encodeURIComponent(selected) + '/nvr-live-trial', {
      method: 'POST', signal: job.signal, cache: 'no-store',
      headers: { Authorization: 'Bearer ' + el('token').value, 'Content-Type': 'application/json' },
      body: JSON.stringify({ consentPrivateMedia: true }) });
    if(!result.ok) { const value = await result.json(); throw Error(value.error || 'NVR video test failed.'); }
    const clip = await result.blob();
    if(nvrClip) URL.revokeObjectURL(nvrClip);
    nvrClip = URL.createObjectURL(clip);
    el('nvr-video').src = nvrClip; el('nvr-video').hidden = false;
    el('nvr-download').href = nvrClip; el('nvr-download').hidden = false;
    el('nvr-status').textContent = 'Clip received. Does the picture play and show the selected camera? You can also download it to a compatible player. Keep it private.';
  } catch(error) { el('nvr-status').textContent = job.signal.aborted ? 'NVR test cancelled.' : error.message + ' Please send only the nvr_live_trial_failed log line if it failed.'; }
  finally { nvrJob = null; el('nvr-test').disabled = false; el('nvr-state-test').disabled = false; el('device').disabled = false; }
});
const cancelMotion = () => { if(motionJob) motionJob.abort(); el('motion-consent').checked = false; };
el('motion-cancel').addEventListener('click', cancelMotion);
el('device').addEventListener('change', cancelMotion);
window.addEventListener('pagehide', cancelMotion);
action('motion-start', async () => {
  const selected = el('device').value;
  if(motionJob || !selected || !el('motion-consent').checked) throw Error('Select one T8910 and confirm motion-test consent.');
  const job = new AbortController(); motionJob = job; el('motion-start').disabled = true;
  el('motion-status').textContent = 'Connecting, then listening for 45 seconds. Walk past the sensor with your existing settings.';
  try {
    const response = await fetch('api/sensors/' + encodeURIComponent(selected) + '/local-motion-trial', {
      method:'POST', headers:{Authorization:'Bearer ' + el('token').value,'Content-Type':'application/json'},
      body:JSON.stringify({consent:true}), cache:'no-store', signal:job.signal });
    const result = await response.json();
    if(job.signal.aborted || el('device').value !== selected) return;
    if(!response.ok) throw Error('Local motion test did not complete: ' + (['admission','busy','cancelled','timeout','session'].includes(result.stage) ? result.stage : 'session') + '.');
    el('motion-status').textContent = 'Local motion test: ' + result.outcome + '. Candidate observations: ' + result.candidates +
      '. This does not confirm phone-independent Home Assistant motion. Share only this summary. No observations can also mean stale values or a clock difference.';
  } catch(error) { el('motion-status').textContent = job.signal.aborted ? 'Local motion test cancelled.' : error.message + ' If it failed, share only the local_motion_trial_failed log line.'; }
  finally { if(motionJob === job) motionJob = null; el('motion-start').disabled = false; el('motion-consent').checked = false; }
});
const cancelIndex = () => { if(indexJob) indexJob.abort(); };
el('index-cancel').addEventListener('click', cancelIndex);
el('device').addEventListener('change', () => { cancelIndex(); el('index-consent').checked = false; });
window.addEventListener('pagehide', cancelIndex);
action('index-start', async () => {
  const selected = el('device').value;
  if(indexJob || !selected || !el('index-consent').checked) throw Error('Select one C31 and confirm index-test consent.');
  const job = new AbortController(); indexJob = job; el('index-start').disabled = true;
  el('index-status').textContent = 'Checking the recent index once. No footage is downloaded.';
  try {
    const response = await fetch('api/cameras/' + encodeURIComponent(selected) + '/recording-index-trial', {
      method:'POST', headers:{Authorization:'Bearer ' + el('token').value,'Content-Type':'application/json'},
      body:JSON.stringify({consentReadRecordingIndex:true}), cache:'no-store', signal:job.signal });
    const result = await response.json();
    if(job.signal.aborted || el('device').value !== selected) return;
    if(!response.ok) throw Error('Index test did not complete: ' + (['admission','busy','cancelled','timeout','malformed','session'].includes(result.stage) ? result.stage : 'session') + '. A failed test does not mean there are no recordings.');
    el('index-status').textContent = 'Index reply: ' + result.outcome + '. Valid intervals: ' + result.valid +
      ', invalid intervals: ' + result.invalid + ', intervals in the requested window: ' + result.overlapping +
      '. This does not confirm that recordings can be played. Please share only this summary, without device details.';
  } catch(error) { el('index-status').textContent = job.signal.aborted ? 'Index test cancelled.' : error.message + ' If it failed, share only the recording_index_trial_failed log line.'; }
  finally { if(indexJob === job) indexJob = null; el('index-start').disabled = false; el('index-consent').checked = false; }
});
action('nvr-state-test', async () => {
  const selected = el('device').value;
  if(!selected || !el('nvr-state-consent').checked) throw Error('Select one camera and confirm read-state consent.');
  if(nvrJob || doorbellJob || cloudJob) return;
  const job = nvrJob = new AbortController();
  el('nvr-test').disabled = true; el('nvr-state-test').disabled = true; el('device').disabled = true;
  el('nvr-status').textContent = 'Connecting and reading settings. This may take up to 45 seconds, followed by connection cleanup.';
  try {
    const result = await fetch('api/cameras/' + encodeURIComponent(selected) + '/nvr-state-trial', {
      method: 'POST', signal: job.signal, cache: 'no-store',
      headers: { Authorization: 'Bearer ' + el('token').value, 'Content-Type': 'application/json' },
      body: JSON.stringify({ consentReadState: true }) });
    const value = await result.json();
    if(!result.ok) throw Error(value.error || 'NVR state test failed.');
    const modes = { 0: 'Away', 1: 'Home', 2: 'Schedule', 3: 'Custom 1', 4: 'Custom 2', 5: 'Custom 3', 47: 'Geofencing', 63: 'Disarmed' };
    el('nvr-status').textContent = 'Configured guard mode' + (value.configuredGuardModeSource === 'inventory' ? ' (cloud inventory)' : ' (local query)') + ': ' + (modes[value.configuredGuardMode] || 'Unknown') +
      '\\nCurrent guard mode: ' + (modes[value.effectiveGuardMode] || 'Unknown') +
      '\\nCamera power: ' + (value.cameraPower || 'Unknown') +
      '\\nUnknown means this read returned no value or an unrecognised one.' +
      '\\nCloud inventory is checked during this test. It is not local confirmation. The effective-mode sensor uses separate reported updates.' +
      '\\nCompare these readings with the Eufy app. No settings were changed.';
  } catch(error) { el('nvr-status').textContent = job.signal.aborted ? 'NVR test cancelled.' : error.message + ' Please send only the nvr_state_trial_failed log line if it failed.'; }
  finally { nvrJob = null; el('nvr-test').disabled = false; el('nvr-state-test').disabled = false; el('device').disabled = false; }
});
action('doorbell-stop', async () => { if(doorbellJob) doorbellJob.abort(); });
action('doorbell-test', async () => {
  const selected = el('device').value;
  if(!selected || !el('doorbell-consent').checked) throw Error('Select one standalone doorbell and confirm private video consent.');
  if(doorbellJob || nvrJob || cloudJob) return;
  const job = doorbellJob = new AbortController();
  if(doorbellClip) URL.revokeObjectURL(doorbellClip);
  doorbellClip = null; el('doorbell-video').removeAttribute('src');
  el('doorbell-video').hidden = true; el('doorbell-download').hidden = true;
  el('doorbell-test').disabled = true; el('device').disabled = true;
  el('doorbell-status').textContent = 'Connecting and checking a ten-second private clip. This may take up to 90 seconds.';
  try {
    const result = await fetch('api/cameras/' + encodeURIComponent(selected) + '/doorbell-video-trial', {
      method: 'POST', signal: job.signal, cache: 'no-store',
      headers: { Authorization: 'Bearer ' + el('token').value, 'Content-Type': 'application/json' },
      body: JSON.stringify({ consentPrivateMedia: true }) });
    if(!result.ok) { const value = await result.json(); throw Error(value.error || 'Doorbell video test failed.'); }
    const clip = await result.blob();
    if(clip.size > 32 * 1024 * 1024) throw Error('The private clip exceeded the test limit.');
    doorbellClip = URL.createObjectURL(clip);
    el('doorbell-video').src = doorbellClip; el('doorbell-video').hidden = false;
    el('doorbell-download').href = doorbellClip; el('doorbell-download').hidden = false;
    el('doorbell-status').textContent = 'Clip received. Does it play and show the selected doorbell? This result does not enable normal live view. Keep the clip private.';
  } catch(error) { el('doorbell-status').textContent = job.signal.aborted ? 'Doorbell test cancelled.' : error.message + ' Please send only the doorbell_rtc_trial_failed log line if it failed.'; }
  finally { doorbellJob = null; el('doorbell-test').disabled = false; el('device').disabled = false; }
});
function cloudControls(busy) {
  for(const id of ['cloud-list','cloud-test','cloud-date','cloud-record']) el(id).disabled = busy;
  for(const id of ['device','load']) el(id).disabled = busy || activeTrialSerial !== null || !!nvrJob || !!doorbellJob;
}
function clearCloudClip() {
  if(cloudClip) URL.revokeObjectURL(cloudClip);
  cloudClip = null; el('cloud-video').removeAttribute('src'); el('cloud-video').hidden = true; el('cloud-download').hidden = true;
}
function resetCloud() {
  cloudGeneration++;
  if(cloudJob) cloudJob.abort(); if(cloudLoadJob) cloudLoadJob.abort();
  cloudJob = null; cloudLoadJob = null; cloudSelection = null;
  cloudControls(false); clearCloudClip(); el('cloud-consent').checked = false;
  el('cloud-record').replaceChildren(new Option('Load a day first', ''));
  el('cloud-status').textContent = 'No cloud recording selected.';
}
el('cloud-date').value = new Date(Date.now() - new Date().getTimezoneOffset()*60000).toISOString().slice(0,10);
el('device').addEventListener('change', resetCloud);
el('cloud-date').addEventListener('change', resetCloud);
el('cloud-record').addEventListener('change', () => { clearCloudClip(); el('cloud-consent').checked = false; });
action('cloud-stop', async () => { if(cloudJob) cloudJob.abort(); if(cloudLoadJob) cloudLoadJob.abort(); });
action('cloud-list', async () => {
  if(cloudJob || cloudLoadJob || nvrJob || doorbellJob || activeTrialSerial !== null) return;
  const serial = el('device').value, day = el('cloud-date').value;
  if(!serial || !/^\\d{4}-\\d{2}-\\d{2}$/.test(day)) throw Error('Select one camera and a recording day.');
  resetCloud();
  const generation = cloudGeneration, job = cloudLoadJob = new AbortController();
  const start = new Date(day + 'T00:00:00'), end = new Date(start); end.setDate(end.getDate()+1);
  const query = { startTime: start.getTime()/1000, endTime: end.getTime()/1000, timezoneOffset: -start.getTimezoneOffset()*60 };
  cloudControls(true); el('cloud-status').textContent = 'Loading existing cloud recording metadata.';
  try {
    const params = new URLSearchParams({ start: query.startTime, end: query.endTime, timezone_offset: query.timezoneOffset, count: 1000 });
    const result = await fetch('api/cameras/' + encodeURIComponent(serial) + '/cloud-history?' + params, {
      signal: job.signal, cache: 'no-store', headers: { Authorization: 'Bearer ' + el('token').value } });
    if(!result.ok) throw Error('Cloud history returned HTTP ' + result.status + '.');
    const value = await result.json();
    if(generation !== cloudGeneration || job.signal.aborted) return;
    if(!Array.isArray(value.records) || value.records.length > 1000) throw Error('Cloud history did not return a valid list.');
    const records = value.records.filter(row => row.hasCloudMedia === true && typeof row.id === 'string' && row.id.length <= 128 && Number.isSafeInteger(row.startTime));
    cloudSelection = { serial, query, records };
    el('cloud-record').replaceChildren(new Option(records.length ? 'Choose one recording' : 'No cloud recordings for this day', ''));
    for(const row of records) el('cloud-record').add(new Option(new Date(row.startTime*1000).toLocaleString(), row.id));
    el('cloud-status').textContent = records.length ? 'Choose one recording and confirm private-video consent.' : 'No cloud recordings returned. Local HomeBase recordings are separate.';
  } catch(error) { if(generation === cloudGeneration) el('cloud-status').textContent = job.signal.aborted ? 'Cloud history cancelled.' : error.message; }
  finally { if(generation === cloudGeneration) { cloudLoadJob = null; cloudControls(false); } }
});
action('cloud-test', async () => {
  if(cloudJob || cloudLoadJob || nvrJob || doorbellJob || activeTrialSerial !== null) return;
  const selection = cloudSelection, recordId = el('cloud-record').value;
  if(!selection || selection.serial !== el('device').value || !selection.records.some(row => row.id === recordId) || !el('cloud-consent').checked) {
    throw Error('Select one existing recording and confirm private-video consent.');
  }
  const generation = cloudGeneration, job = cloudJob = new AbortController();
  clearCloudClip(); cloudControls(true); el('cloud-status').textContent = 'Downloading and checking the private video preview. This may take up to 95 seconds.';
  try {
    const result = await fetch('api/cameras/' + encodeURIComponent(selection.serial) + '/cloud-recording-trial', {
      method: 'POST', signal: job.signal, cache: 'no-store',
      headers: { Authorization: 'Bearer ' + el('token').value, 'Content-Type': 'application/json' },
      body: JSON.stringify({ consentPrivateMedia: true, recordId, ...selection.query }) });
    if(!result.ok) { const value = await result.json(); throw Error(value.error || 'Cloud recording test failed.'); }
    const clip = await result.blob();
    if(generation !== cloudGeneration || job.signal.aborted) return;
    if(clip.size > 32*1024*1024) throw Error('The private preview exceeded the test limit.');
    cloudClip = URL.createObjectURL(clip);
    el('cloud-video').src = cloudClip; el('cloud-video').hidden = false;
    el('cloud-download').href = cloudClip; el('cloud-download').hidden = false;
    el('cloud-status').textContent = 'Preview checked. Does it play and show the selected recording? Keep footage private.';
  } catch(error) { if(generation === cloudGeneration) el('cloud-status').textContent = job.signal.aborted ? 'Cloud preview cancelled.' : error.message + ' Please send only the cloud_recording_trial_failed line if it failed.'; }
  finally { if(generation === cloudGeneration) { cloudJob = null; cloudControls(false); } }
});
window.addEventListener('pagehide', () => { resetCloud(); abortStream(); if(nvrJob) nvrJob.abort(); if(nvrClip) URL.revokeObjectURL(nvrClip); if(doorbellJob) doorbellJob.abort(); if(doorbellClip) URL.revokeObjectURL(doorbellClip); });
</script></html>`;
}
