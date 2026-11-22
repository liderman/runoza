# Cherry Studio: What to use in Runóza

The official [chat](https://www.cherryai.com/docs/en/cherrystudio/preview/chat/), [input panel](https://cherryai.com/docs/en/advanced-basic/workbench/composer-efficiency/) and [model selection](https://github.com/CherryHQ/cherry-studio/tree/2930c77c299f182a5b5c746328aab18ee152f860/src/renderer/components/ModelSelector) are studied. We transfer interaction patterns, the implementation of our own to Gravity UI; Cherry Studio code under AGPL-3.0 is not borrowed.

| Priority | Pattern. | How to apply |
| --- | --- | --- |
| Now. | Short line of model, details separately | Logo, provider and key search opportunities; full profile in settings and conversation information. |
| Done. | One `+` menu for attachments, skills and MCP | Tab shifts focus to a button, Enter or space opens a menu, arrows move focus, Enter selects, Esc closes and returns focus. Skills and MCP open in separate lists. Slash search, model selection and submission remain available as before. |
| Then | Fixed Actions and Saved Prompts | Start with a small set; separate the layout of the chat and the workspace; substitute the prompt show as editable text before sending. |
| Then | Actions in conversation and communication | Leave frequent near the object, rare - in the menu; add export and duplication as separate operations, not to be confused with the answer branch. |
| Later. | Comparison of responses from several models | Separate explicit mode with a cost per model; do not include parallel queries imperceptibly in the usual selection. |

In [models.dev](https://github.com/anomalyco/models.dev#logos), logos are tied to providers and model developers. Runóza uses a local selection of SVG; if the desired sign is not available, the text remains. Features and tariffs are associated with the exact pair of connection URLs and model IDs. Image generation, audio, and other modalities in the card describe the model, not the client’s set of functions. Prices are basic rates from a catalog shot, not an account and not an estimate for the tokens of a particular conversation. For the story, the current profile of the model of the last completed launch is shown, not the historical tariff.
