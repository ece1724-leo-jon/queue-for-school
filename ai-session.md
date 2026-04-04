# AI Session Log

## Session: Implementing File Upload Feature

**Date:** April 3, 2026  
**Tool used:** Claude Code (CLI)  

---

### Interaction 1: Scoping the work by exploring existing code

I had already finished the UI mockup for the file upload feature (a standalone preview page at `file.html` with drag-and-drop, validation checks, progress bar, etc.) but hadn't wired any of it into the actual app. I asked Claude to help implement the feature and figure out what technologies we'd need.

What surprised me was that instead of immediately suggesting new libraries, it spent time reading through the server code (`server/index.ts`, `server/storage.ts`, `server/db.ts`) and found that most of the backend infrastructure was already in place — Multer for handling uploads, an S3 storage layer with local fallback, the `attachments` database table, and even REST endpoints for upload and download. The upload was only hooked up to the question queue though, not marking, and the frontend was using a plain `<input type="file">` instead of the designed drag-and-drop UI.

The conclusion was that zero new dependencies were needed. That saved us from adding unnecessary packages and kept the PR clean. If I had just started coding without that audit, I probably would have installed something like `react-dropzone` when we didn't need it.

---

### Interaction 2: Refactoring the upload flow with progress tracking

The original upload code in `App.tsx` used a simple `fetch()` call — fire and forget, no progress feedback. The UI mockup had a progress bar and validation check animations, so we needed real upload progress.

I asked Claude to implement the full upload flow. It replaced the `fetch()` with `XMLHttpRequest` to get `upload.onprogress` events, which `fetch` doesn't support natively. It also wired up a state machine (`uploading` -> `validating` -> `complete` or `error`) that drives the progress bar and updates the validation checks (the "Security scan" check flips from "pending" to "pass" after upload completes).

One thing I had to think about: the original code only allowed file uploads on the question queue (`if (effectiveType === 'question' && attachmentFile)`). We decided to enable it for both marking and question queues since students doing marking demos often want to show their circuit diagrams or terminal screenshots. This meant updating the server too — adding an `attachment` field to `MarkingEntry` and the `join-marking` socket handler.

---

### Interaction 3: Figuring out where to put things

The trickiest part of the session wasn't the logic — it was deciding how to organize the code. The mockup had everything in a single `FileUploadPreview.jsx` file (it was a design preview, not production code). We needed to extract the reusable parts into something the main app could import without duplicating CSS or creating circular dependencies.

We ended up with:
- `src/components/FileUpload.tsx` — all the upload UI components (`FileDropZone`, `UploadProgress`, `ValidationChecks`, `AttachmentIndicator`, `AttachmentPreview`) plus a `useFileUpload` hook that manages file state, validation, and cleanup
- The CSS went into `index.css` inside the existing `@layer base` block rather than a separate file, since the styles need access to the app's CSS variables (`--marking-primary`, `--bg-secondary`, etc.)
- The existing `FileUploadPreview.jsx` and `FileUploadPreview.css` were left untouched — they still power the standalone design preview page at `/file.html`

The `useFileUpload` hook was a good call. It bundles together `fileInfo`, `fileError`, `validationChecks`, `handleFile`, `removeFile`, and `resetFile` so the `QueueCard` component doesn't need six separate `useState` calls for file management. It also handles `URL.createObjectURL` cleanup on unmount/removal, which is easy to forget and causes memory leaks.
