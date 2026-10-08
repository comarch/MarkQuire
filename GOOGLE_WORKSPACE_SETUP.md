# Comarch MarkQuire - Google Workspace and Google Drive setup

This guide covers a private, organization-managed deployment of Comarch MarkQuire. It configures the web application, OAuth consent, Drive entry points, and an internal Google Workspace Marketplace listing.

Once configured, the app will appear in Google Drive under:

- **"New" -> "More" -> "Comarch MarkQuire"**
- Right-click context menu: **"Open with" -> "Comarch MarkQuire"** for `.md` and `.markdown` files.

Use the ready-to-paste descriptions and screenshots from the [brand and listing kit](./docs/BRAND.md).

This guide and `google-workspace-manifest.json` use the reference deployment at
`https://comarch.github.io/MarkQuire/`, published by the `Pages` workflow once
the repository variable `ENABLE_GITHUB_PAGES` is set to `true` and GitHub Pages
is enabled for the repository. When you host the app somewhere else, replace
that origin and the support address in both places, and build with
`MARKQUIRE_BASE_PATH` set to the path the app is served from (`/` for a root
deployment, `/MarkQuire/` for the Pages subpath).

---

## 1. Google Cloud Console Setup

### 1.1 Create or Select Project

1. Navigate to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project, for example `markquire-workspace`, or select an existing organization project.

### 1.2 Enable Required APIs

Navigate to **APIs & Services -> Library** and enable:

1. **Google Drive API**
2. **Google Workspace Marketplace SDK**

---

## 2. OAuth Consent Screen Configuration

1. In the Google Cloud Console, navigate to **APIs & Services -> OAuth consent screen**.
2. Select **Internal** (Wewnętrzny) user type:
   - Selecting _Internal_ limits access to users in your Google Workspace domain.
   - It **does not require Google verification or review**, so you can deploy immediately.
3. Fill in basic information:
   - **App name**: `Comarch MarkQuire`
   - **User support email**: Your support or team email
   - **Developer contact information**: Your developer email
4. In **Scopes** (Zakresy), click **Add or Remove Scopes** and add:
   - `https://www.googleapis.com/auth/drive.file` (Per-file access: view and manage Google Drive files opened or created with this app)
   - `https://www.googleapis.com/auth/userinfo.profile` (View user profile)
   - `https://www.googleapis.com/auth/userinfo.email` (View user email address)
5. Save and continue.

---

## 3. Create OAuth 2.0 Credentials

1. Navigate to **APIs & Services -> Credentials**.
2. Click **Create Credentials -> OAuth client ID**.
3. Select Application type: **Web application**.
4. Name: `Comarch MarkQuire Web Client`.
5. Under **Authorized JavaScript origins**, add:
   - Your production origin without a path: `https://comarch.github.io`
   - For local development: `http://localhost:3000`
6. Click **Create**.
7. Copy the generated **Client ID**.

Paste this Client ID into:

- `.env` file as `VITE_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com`
- Or configure it directly inside the app under **Settings (gear icon) -> Google Cloud OAuth 2.0 Client ID**.

---

## 4. Google Drive UI Integration (Drive SDK)

To make the app appear in Google Drive's "Nowy" (New) and "Otwórz w" (Open with) menus:

1. In Google Cloud Console, navigate to **APIs & Services -> Enabled APIs & Services -> Google Drive API**.
2. Click the **Drive UI Integration** tab (or **Drive SDK** tab depending on console version).
3. Fill in the fields:
   - **Application Name**: `Comarch MarkQuire`
   - **Short description**: `Write and review portable Markdown without leaving Google Drive.`
   - **Long description**: Use the approved copy from [docs/BRAND.md](./docs/BRAND.md).
4. Upload application icons (found in `/public/icons/`, and served by the
   deployment at `https://comarch.github.io/MarkQuire/icons/`):
   - **Application icon (16x16)**: `/public/icons/icon-16.png` - appears next to the app name in the Drive menu.
   - **Application icon (32x32)**: `/public/icons/icon-32.png` - appears in file listings and context menus.
   - **Application icon (128x128)**: `/public/icons/icon-128.png` - appears in Marketplace and app listings.
5. Configure URLs (plain URLs without a `state` parameter - Drive appends
   the `state` query parameter automatically):
   - **Open URL**: `https://comarch.github.io/MarkQuire/`
   - **Create (New) URL**: `https://comarch.github.io/MarkQuire/`

   Do not enter the legacy `${state}` template in these fields. With the
   "Automatically show the OAuth 2.0 consent screen" option enabled, saving
   a URL containing `${state}` fails with
   `Request contains an invalid argument` (verified on a real project).

6. Configure Document creation:
   - Check **"Allow users to create new documents"**.
   - **New document menu item label**: `Markdown Document` (or `Dokument Markdown`).
7. Configure File associations:
   - **Default MIME types**:
     - `text/markdown`
     - `text/x-markdown`
     - `text/plain`
   - **Default file extensions**:
     - `md`
     - `markdown`
   - **Secondary MIME types**:
     - `text/plain`
8. Click **Save Changes**.

---

## 5. Publish in Internal Google Workspace Marketplace

To make the application available domain-wide or installable from the internal marketplace:

1. In Google Cloud Console, navigate to **Google Workspace Marketplace SDK -> App Configuration**.
2. Under **App Visibility**, select **Private** (visible only to users in your organization).
3. Under **Installation Settings**, choose:
   - **Individual + Admin Install**: Allows individual users to install from the marketplace and admins to install for all domain users.
4. Fill in listing details:
   - App title, description, and categories.
   - Product screenshots from `/docs/assets/`.
5. In **Store Listing -> Publish**, click **Publish**.
6. Confirm listing availability with a test organizational unit before wider rollout. Availability and review requirements depend on current Google policy and your Workspace administration settings.

---

## 6. How the Integration Works Under the Hood

### When a user selects "New" -> "More" -> "Comarch MarkQuire"

1. Google Drive redirects the user's browser to:
   ```
   https://comarch.github.io/MarkQuire/?state={"action":"create","folderId":"<FOLDER_ID>","userId":"<USER_ID>"}
   ```
2. The application reads `state` parameter:
   - Authenticates user via Google Identity Services (GIS).
   - Calls Google Drive API `POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart` to create a new `.md` file in the selected folder.
   - Updates URL to `?fileId=<FILE_ID>`.

### When user opens an existing file

1. Google Drive redirects the user to:
   ```
   https://comarch.github.io/MarkQuire/?state={"action":"open","ids":["<FILE_ID>"],"userId":"<USER_ID>"}
   ```
2. The application loads the file content and metadata:
   - `GET https://www.googleapis.com/drive/v3/files/<FILE_ID>?alt=media`
   - `GET https://www.googleapis.com/drive/v3/files/<FILE_ID>?fields=id,name,mimeType,modifiedTime,webViewLink,capabilities`

### Google Drive Comments API

Comments are saved directly into the Google Drive file's discussion thread using Google Drive Comments API v3:

- **List comments**: `GET /drive/v3/files/<FILE_ID>/comments?fields=*`
- **Create comment**: `POST /drive/v3/files/<FILE_ID>/comments?fields=*` with `{ content, quotedFileContent, anchor }`
- **Replies & Resolve**: `POST /drive/v3/files/<FILE_ID>/comments/<COMMENT_ID>/replies?fields=*` with `{ content, action: 'resolve' }`
- Comments created in the production integration are Google Drive comments attached to the file resource.

---

## 7. Optional companion service

Real-time co-editing, Drive change notifications, server-side AI access,
and organization-wide search need a relay that a static page cannot
provide. The `companion/` directory ships this as one optional,
self-hosted service. It is never required: a deployment without it keeps
every core feature, and the SPA never depends on it.

### 7.1 Deploy the container

```
docker compose up -d
```

The compose file runs the SPA behind nginx and the companion next to it,
with nginx routing `/v1/`, `/ws`, and `/events` to the service. Give the
companion a data volume; it writes a JSONL audit log and search index
there.

### 7.2 Configuration

| Variable               | Effect                                                   |
| ---------------------- | -------------------------------------------------------- |
| `PUBLIC_URL`           | Public HTTPS base Drive webhooks call back into          |
| `DRIVE_WEBHOOK_SECRET` | Shared secret the SPA sends when registering watches     |
| `GEMINI_API_KEY`       | Enables the AI proxy; the key stays server side          |
| `GEMINI_MODEL`         | Model name for the AI proxy (default `gemini-2.0-flash`) |
| `SLACK_WEBHOOK_URL`    | Enables integration notifications                        |
| `AUDIT_LOG_PATH`       | JSONL audit log file                                     |
| `SEARCH_INDEX_PATH`    | JSONL search index file                                  |
| `RETENTION_DAYS`       | Compliance retention window for audit entries            |

### 7.3 User-facing setup

Authors enter the companion base URL once in settings (for example
`https://markquire.example.invalid`). The app then joins editing rooms for
open Drive files, registers change watches with its own short-lived
OAuth token, pushes saved documents into the search index, and forwards
review activity to the configured integrations.

### 7.4 Boundaries

- The client's OAuth token is used once, for a watch registration, and
  never stored by the service.
- Webhook callbacks without the shared secret are rejected and audited.
- Relay documents live in memory only; Drive remains the durability
  layer.
- The search index stores document content outside Drive, so it exists
  only in your organization's own deployment.
- Administrators export the audit log from `/v1/audit/export` and read
  retention statistics from `/v1/audit/stats`.
