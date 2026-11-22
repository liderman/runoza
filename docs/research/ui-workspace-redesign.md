# Reconstruction of the working interface before step 5

Date: 2026-11-11. Local development, no push. Continuation of the first UI check, with a revision of the application structure.

## References and decisions

The official materials [ChatGPT Projects](https://help.openai.com/en/articles/10169521-projects-in-chatgpt), [ChatGPT search](https://help.openai.com/en/articles/10056348-finding-your-chats-projects-and-files-in-chatgpt), [Claude projects](https://support.claude.com/en/articles/9519177-how-can-i-create-and-manage-projects), [Codex/ChatGPT Work functions](https://developers.openai.com/codex/app/features) have been studied. An additional source of requirements is the Codex, Claude, and ChatGPT scripts described by the user. The solutions below are to adapt the patterns to the Runoza, not to claim an objectively better market design or an exact copy of a particular version of the product.

| Script | Problem. | Decision taken |
|---|---|---|
| Navigation | Sections overshadow daily work | New Conversation, Projects, Search and Story in Permanent Sidebar; Settings in Bottom Menu |
| Projects | List of projects as a file selector | Disclosed Conversation Groups; Project Page Default Shows Conversations and Creation Action; Instructions, Files, and Participants – Individual Tabs |
| History. | Hidden in the drop-down list | Visible lines of conversations, highlighting active, winding down projects; personal conversations separately |
| chat | Multiple panels above messages and fixed 70vh | Workspace to viewport height; compact header, scrollable messages and input field at the bottom |
| Model | Large field with provider and full ID in the cap | Compact button near input; search in menu; provider is displayed in secondary text in variants |
| Communications | Repetitive long buttons | Edit/repeat icons with available names; additional versions upon request |
| Account settings | All shapes. | Profile and data, security, active sessions - separate subsections |
| Administration | Create a user, switches, SSO and log in one thread | Subsections of users, functions, SSOs, logs; user addition and access editor in dialogues with explicit preservation |
| Providers | List next to the long form | Connection list and dialog editor; key, model, and connection checks saved |
| Files. | There are many equivalent buttons on each line. | The attachment remains an explicit action; viewing, downloading and deleting is in the file menu. Personal files are opened separately from the project directory. |
| Drafts | Transitions between sections lost data | General protection of form/message during navigation and beforeunload; continue editing or explicitly opt out of changes |
| Sending. | The AIKit button did not have an accessible name. | MessageList AIKit + UIKit TextArea/Button; explicit names Send/Stop, Enter sends, Shift+Enter carries a string, IME composition does not send |

## Implementation

Existing versions of Gravity Navigation 8.0.0, UIKit 8.0.0, AIKit 3.4.0 and Icons 2.23.1 are not added. Groups and folding are public Navigation API; Select is public renderControl/renderOption model. Forms, tabs, dialogs, menus and indents are standard components. CSS describes only its own chat container, scrolling and width; internal library selectors, hidden staff buttons and DOM sub-s.

Server model rights, S3 work, instructions and attachments are not changed: project files are still transmitted to the model only after explicit selection. RAG / automatic reading of the project is not declared.

## Verification

- `npm run check`: Formatting, Packet Boundaries, TypeScript, Build, 7 Unit Tests and 569 Packet Licenses – PASS.
- Integration scenarios: 39 PASS, 1 SKIP, 0 FAIL. skip - optional restart RustFS, tested in step 4.
- Isolated browser stand: creating a project and conversations inside it; grouping in the panel; personal conversation; Enter and the send button; streaming response, available stop name; restoring the conversation after reload; search / empty result; warning when transitioning with a draft and canceling the transition; leaving the changed new SSO settings; refusing to change the provider when closing.
- Verified light/dark themes, EN/RU, narrow 375×812 and wide 1400×900 viewport. On a narrow screen width document equals viewport width, document height equals viewport height; input field remains available. Markdown checked visually and by calculated colors, including the list in the dark theme.
- A full audit of the availability of the entire third-party Markdown renderer is not declared by this stage.

## Existing product boundaries

The story uses the current API of the last 200 available conversations; the search filters this downloaded list, which is reflected in the "Search in the List" placeholder. Full-text server search, archiving and transferring existing conversation between projects were not added. If you explicitly reject changes, drafts are not saved; beforeunload uses a standard browser warning.

Local Compose Updated: API/worker healthy, migrations completed successfully, `/health/ready` returns `ok`, secure API without session returns 401. No new migrations.

Isolated browser stand stopped; temporary database, bucket and test Compose volumes cleared; basic user data was not used for tests.
