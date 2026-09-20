# Agent guidance

## GitHub issue comments

- Never include Martin's local camera names, room names, Home Assistant entity names, serials, account details, or other local device labels in public comments. Use the model, device type, or a neutral phrase such as "one of my cameras".
- Write replies for the reporter, not for an internal engineering review. Lead with what changed, what still does not work, and the next useful action.
- Prefer ordinary words. Explain the user-visible effect before mentioning protocol names, parser stages, frame types, or transport details. Include technical terms only when the reporter needs them to test or understand the result.
- Keep related issues connected in plain language. Say that a shared picture-delivery problem may affect several reports, rather than listing internal implementation vocabulary.
- Do not call a report fixed until the reporter confirms the relevant hardware behaviour. Separate discovery, controls, snapshots, live video, and events when their results differ.
- Do not publish a release merely to create activity. Group related fixes, verify them locally, then release when there is a definite testable change.
- Before posting or editing a comment, check the final text for em dashes, en dashes, semicolons, literal `\\n` sequences, and other unintended control characters.
- Send Markdown with real line breaks. When using the GitHub API, build the body from a temporary Markdown file and verify the stored body through the API after posting.
- Thank the reporter once for the evidence they supplied, vary the wording naturally, and finish with a separate signoff.
