# Projects, files and attachments

Step 4, local implementation 2026-11-11. EN/RU interface; `005_resources` migration complements existing data, does not recreate tables of previous steps.

## Working with projects

In the **Projects and Files** section, you can create a project, add instructions and provide access to existing users of the organization by email: the owner manages participants and deletes the project; the editor changes instructions, files and conversations; the viewer can browse and download files. The system administrator does not gain implicit access to other people's data.

Start a personal conversation from the sidebar. Start a project conversation from its expanded group in the sidebar or from the project’s **Conversations** tab. Open **Attachments** to upload, view, or attach files to the next message. Once a conversation is created, its space does not change. Project participants see its conversations. Personal files and conversations are only available to the owner.

Project instructions are recorded at the time of queuing the response and transmitted as a system prompt. Attachments are added to the context of the selected branch. Repeat uses the attachments of the original message; editing the message retains them. Project files are not added to each request automatically: the user selects the attachments explicitly. File text is data, not privileged instructions. The model can still make mistakes, including following the instructions inside the file; until step 5, tools and execution of commands are not available to it.

## Supported Files and Limitations

- One file: from 1 byte to 64 MiB. Uploader quota: 1 GB and 1000 files, including unfinished and pending files, project files count against the uploader’s quota.
- For model and secure text preview: UTF-8 without NUL, maximum 1 MiB and 60,000 characters, `txt md csv json jsonl yaml yml xml log ts tsx js jsx py go rs java c h cpp css html sql sh` extensions.
- A maximum of 10 attachments and 60,000 characters of the contents of the attachments in a single message, the total context of the thread together with the instructions is limited to 120,000 characters.
- Other formats are stored and downloaded. PDF/OCR, archive decompression, indexing/RAG, multimodal analysis, image generation and editing are not implemented.
- File artifacts are now stored files, and the agent's work will be automatically published with the performer in step 5.

## Storage and life cycle

`@runoza/storage` is an infrastructure S3 client; `@runoza/resources` is projects, rights, file metadata and cleanup. API and worker use the same `S3_*` configuration: RustFS from Compose or a dedicated external S3 bucket. The browser does not issue an S3 address, object key, keys or presigned URL. All upload/download pass through the authenticated Runoza API.

`POST /api/v1/files` reserves a quota and creates `pending`. `PUT /api/v1/files/:id/content` receives the `application/octet-stream` stream; the server performs multipart at 5 MiB, checks the size and SHA-256, saves the multipart ID for recovery. The upload has a one-time claim, a request period of 120 seconds and repeated session/rights checks between parts. After successful completion, the status becomes `ready`. A failed upload moves to `deleting`. A retry creates a new file record.

The `/content` download endpoint streams content, supports a single byte range (206/416), and returns `attachment`, `application/octet-stream`, and `nosniff` headers. Preview `/preview` gives text to JSON, React displays it without executing HTML. User MIME is not used to execute or embed content. Antivirus scan is not yet.

Worker removes `deleting` objects once a minute, interrupts their multipart and deletes attachment links. `pending` older than 15 minutes is translated into `deleting`. Multipart and objects without a database record older than 24 hours are cleared in the prefix `files/`. In unavailable S3, the removal is repeated; quota is released after physical cleaning. Bucket/prefix must belong to one installation Runoza, otherwise the cleaning may affect other objects.

Deletion of the attachment is blocked while there is an active response in the conversation using it. Deletion of the project is blocked with active responses and deletes all of its conversations and files for participants. After physical deletion, the links to the file disappear from the messages; the already saved model answers are not edited and may contain quotes from the file. Deletion of the conversation does not delete independent space files. Revocation of membership prohibits new requests; checks the editor's right during the response, SSE rechecks access.

## Export and deletion

In the **Account** section, the button **Export my data** downloads NDJSON: profile without secrets, available projects, conversations with messages and attachment links, metadata of ready-made files and links to an authenticated download API. This is manifest, not ZIP with binary files: content is downloaded separately. Rights are verified during export.

Files, conversations, and proprietary projects are removed from the confirmation interface. Complete deletion of account, backups, and audit with a separate button is not included in this stage; the organization’s retention policies will require a separate solution.

## Testing

`tests/integration/resources.test.ts`: real PostgreSQL/RustFS, roles and isolation, secure preview, Range and SHA-256, 64 MiB file, instructions and attachments in a request to a local fixture provider, revocation of access, cancellation / download, quotas, export, deletion and orphan cleanup. Optional `TEST_RESTART_STORAGE=true` restarts only the `runoza-stage4-tests` container and checks the safety of the file.

Local start: Compose with `deploy/compose/test.yaml`, `runoza-stage4-tests` project, `postgres rustfs` services; then build and `npm run test:integration` with `TEST_DATABASE_URL`, `TEST_S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`. Test bases/bucket are created separately. Do not use test override in working deployment. CI also raises RustFS.

## Navigation and forms

The Projects and Files section is located in the side menu (on the narrow screen, on the mobile menu). Within the project, conversations, instructions, files and participants are separated by tabs; the first one opens the conversation tab. Instructions are entered into a multi-line field with explanation and example in the hint. Project files do not automatically enter context: they must be selected in the chat attachments. The Select button confirms the choice, the **Cancel** button leaves the previous choice. Uploading saves the file to storage regardless of whether you confirm the selection.
