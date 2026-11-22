# Models and reasoning

**Settings → Model Providers** shows the endpoint, API key configuration, and connection status. On save, Runóza requests `/models` and caches the response in PostgreSQL. A failed discovery request leaves the connection and the last successful catalog intact.

System administrators can manage models in **Settings → Models**:

- Search by name, ID, group, or connection. Bulk selection includes all search results, including rows outside the visible page.
- Enable or disable individual models or whole groups. When a search filter is active, group actions apply to matching models.
- Enabled models and groups with enabled models appear first. Grouping uses the vendor prefix and known vendor names. OpenRouter aliases such as `~vendor/...` are grouped under the vendor without inheriting an exact-match profile.
- Refresh the catalog manually, by saving a connection, or by opening the section when the cache is older than 24 hours. Discovered models start disabled. Refreshing preserves enabled states, overrides, and previously discovered IDs.
- Use **Add by ID** for servers without model discovery. Manually added models start disabled.

Clicking on the name opens the group and reasoning settings. Protecting unsaved changes works when closing and navigating. Detect automatically removes manual override; Unsupported hides control in the chat, but doesn't tell the provider to turn off its own reasoning.

## Capability detection

Order: manual override → metadata `/models` → exact built-in profile → unknown. Built-in directory is in `packages/contracts/src/models.ts`; partial matches and assumptions on user aliases are not used.

OpenRouter reports `reasoning.supported_efforts`, `default_effort`, `mandatory`. `null` in supported_efforts means that all gateway levels are permissible, no field means support for all levels. When mandatory=true level none is excluded. When default_enabled=false, the default value becomes none if disconnection is allowed. Individual models can only support budgets: if effort levels are not declared and there is no known profile, manual adjustment is required.

Supported modes of transmission:

| Format | Body of request |
| --- | --- |
| OpenRouter | `reasoning.effort`, for none - `reasoning.enabled=false` |
| OpenAI-compatible / LiteLLM | `reasoning_effort` |
| Thinking budget | `thinking.type=enabled` + `budget_tokens`; none → disabled |
| Enable thinking | `chat_template_kwargs.enable_thinking` - Binary Flag |

For a binary format, different non-zero levels have the same meaning of "on." The format is chosen for a specific endpoint, not just the trade name of the model. LiteLLM is able to convert reasoning_effort; the completeness of discovery depends on its configuration.

In the chat, the discrete slider contains "Default" and only the allowed levels. In the absence of a configured default, the parameter is not transmitted; if default is set by a profile, it is used. "Off" and "Default" are different. Change the model resets the slider to default. The server revalidates the selection, includes it in the idempotency test and saves an effective launch payload. The client cannot replace the arbitrary API query fields.

## Response token limit

Each model has a "Maximum Response, Tokens" field in its settings. Priority: manual value → directory limit → provider-side default value. Clear the field to remove the override. The catalog value appears under the field when available.

For OpenRouter, `top_provider.max_completion_tokens` is used; for compatible directories, `max_output_tokens` and `max_completion_tokens` are also recognized. Positive integers are accepted. Context size is not used instead of the response limit. If there is no metadata, Runoza does not send `max_tokens` and does not leave a hidden fallback SDK.

The limit is fixed along with the launch parameters in the existing `reasoning_config` JSON snapshot, applies to both the chat and all model calls in the agent. The change of settings affects the next launches. No additional database migration is required. After updating the old installation, update the directory to fill in new metadata.

Manual thinking budget must be at least 1024 and strictly below the known effective response limit; fixed ceiling 3072 no longer. Provider can take into account the reasoning in output tokens. Catalog maximum does not guarantee such a response length: the remaining context, the limitations of a particular endpoint and the natural completion of generation.

## Current boundaries

- Text chat-completions path and text tools; Responses API, image generation/editing, and raw reasoning text display are not implemented by this revision.
- When the effective limit is exhausted, the agent informs OUTPUT_LIMIT. The override does not override the physical limitations of the model or provider.
- A large directory is shown in groups, within a group in portions of 30. The server limits the discovery of 2000 ID and the response to 4 million characters. It is not a limit on the length of the files that the agent writes.
- The administrator is responsible for the compatibility of the manual profile with the endpoint. An unsupported format may be rejected by the provider. The presence of a model in the directory does not guarantee access to it at this tariff / key.

Sources: [OpenRouter reasoning](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens), [OpenRouter models](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties), [LiteLLM reasoning](https://docs.litellm.ai/docs/reasoning_content).


## Model selection and effort (6.2)

In the chat, models are grouped with unselectable titles; provider filters are available above the search. Next to the model, the actual level of effort is shown, without a separate reasoning label. The slider starts with the recommended level of the model; it can be restored with a separate button. If the provider does not report a value, the interface honestly shows "Auto" without guessing the level. The top level for profiles longer than three options is accompanied by a brief highlight and an explanation of cost; the animation respects the system setting for reduced motion.

The administrative directory sorts the models that are turned on and the groups above when you open them, and the switches don't change the order, and they don't fold the last group that's turned off while you're working; the next sorting happens when you reopen them, and the lines are highlighted when you hover and focus.

### Compact menus (2026-11-12)

The recommended level is marked with a neutral label; the title is secondary, the value is highlighted. The slider does not reserve space for the duplicate tooltip. The height of the model selection is limited, scrolling the list does not take the filters of the providers to the area of drag and drop windows. Details: [UI check](research/ui-brand-and-header.md).
