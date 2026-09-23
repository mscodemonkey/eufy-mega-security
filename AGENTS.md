# Agent guidance

## GitHub issue comments

- Never include Martin's local camera names, room names, Home Assistant entity names, serials, account details, or other local device labels in public comments. Use the model, device type, or a neutral phrase such as "one of my cameras".
- Write replies for the reporter, not for an internal engineering review. Lead with what changed, what still does not work, and the next useful action.
- Prefer ordinary words. Explain the user-visible effect before mentioning protocol names, parser stages, frame types, or transport details. Include technical terms only when the reporter needs them to test or understand the result.
- Start with `Hey {name},` or `Hey @{handle},` when the reporter's name or handle is known. Do not invent a name or force a greeting when neither is available.
- Keep support updates to friendly prose, normally two to four short paragraphs. Do not turn them into bullet-point status reports, implementation summaries, or mini release notes.
- Use this order when each part applies: say what was fixed in the latest release, ask the reporter to update and retest, name exactly what result or log line to send, say plainly what was not fixed, then thank them once if they tested or supplied evidence last time.
- Do not mention internal event numbers, protocol names, parser stages, encryption, frame types, transport counters, or how diagnostics work. The only technical text a reporter normally needs is the exact log event or line they should copy if the retest still fails.
- Ask for the smallest useful follow-up. Usually that is whether the behaviour now works and one specifically named log line only if it does not. Do not ask the reporter to interpret fields or explain what each field means.
- Keep related issues connected in plain language. Say that a shared picture-delivery problem may affect several reports, rather than listing internal implementation vocabulary.
- Do not call a report fixed until the reporter confirms the relevant hardware behaviour. Separate discovery, controls, snapshots, live video, and events when their results differ.
- Do not publish a release merely to create activity. Group related fixes, verify them locally, then release when there is a definite testable change.
- Before posting or editing a comment, check the final text for em dashes, en dashes, semicolons, literal `\\n` sequences, and other unintended control characters.
- Send Markdown with real line breaks. When using the GitHub API, build the body from a temporary Markdown file and verify the stored body through the API after posting.
- Thank the reporter once for the evidence they supplied, vary the wording naturally, and finish with a separate signoff.
