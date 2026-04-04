# In-person School Queue Management System

A real-time queue management system for TA practical sessions. Built with React + Socket.IO.

**Live demo:** [queue.ictrl.ca](https://queue.ictrl.ca) (note: the live version may not include the latest features such as UofT OTP auth and file uploads)

**Demo video:** [queue.ictrl.ca/video](https://queue.ictrl.ca/video)

![Homepage](images/homepage.png)

## Features

- 📝 **Dual Queues**: Separate queues for marking and questions
- ⚡ **Real-time Updates**: No page refresh needed
- 🔔 **Browser Notifications**: Get notified when your turn approaches
- 🔗 **Connection Indicator**: Know your connection status at a glance
- 👨‍🏫 **TA & Student Views**: Toggle between perspectives
- 📱 **Responsive Design**: Works on desktop and mobile
- 🌙 **Dark Mode**: Switch between light and dark mode
- 🔐 **UofT OTP Authentication**: Email-based OTP login for students and TAs
- 📎 **File Uploads**: Attach screenshots, handwritten work, or documents when joining a queue


## Screenshots
Students can join the queue and wait for their turn. If they see similar questions get asked, they can follow the question and get notified when it is answered.

![Student View](images/otherstudent-follow-question.png)

When student get called, they will receive a notification and can raise their hand.

![Student View](images/get-called.png)

TA can view the queue and call the next student. They can also cancel the call if the student is not ready.

![TA View](images/ta-view.png)

## Stress Test

The system has undergone extensive stress testing using Cypress end-to-end tests. These tests simulate multiple students and TAs interacting with the system simultaneously—joining queues, switching between types (marking/questions), being called, and managing rapid updates. The app was able to handle dozens of concurrent users adding, removing, and updating questions in real time, ensuring that all state changes were reflected without data loss or UI glitches.

Example cypress scenarios include:
- Simulating 100+ students joining and leaving the queue in rapid succession
- Handling network disconnects and reconnections gracefully
- Ensuring the queue state stays consistent across all connected clients

These tests give confidence that the queue management logic is robust and performs well even under heavy classroom usage.

## Quick Start

### 1. Install Dependencies

```bash
# Frontend
npm install

# Backend
cd server
npm install
```

### 2. Start the Server

**Basic (no email, local file storage):**

```bash
cd server
npm run dev
```

**With email notifications enabled:**

```bash
cd server
TA_EMAIL_ALLOWLIST="ta1@mail.utoronto.ca,ta2@mail.utoronto.ca" \
APP_BASE_URL="http://localhost:5173" \
SMTP_HOST="smtp.gmail.com" \
SMTP_PORT="587" \
SMTP_USER="your-email@gmail.com" \
SMTP_PASS="your-app-password" \
SMTP_FROM="ECE Queue <your-email@gmail.com>" \
npm run dev
```

> **Gmail setup:** You need a Gmail [App Password](https://myaccount.google.com/apppasswords) (not your regular password). Enable 2-Step Verification on your Google account first, then generate an app password.

The server will start on `http://localhost:3001`.

### 3. Start the Frontend

In a new terminal:

```bash
npm run dev
```

The app will open at `http://localhost:5173`

## Usage

### For Students

1. Open the app in your browser
2. Log in with your UofT email (an OTP code will be sent)
3. Enable notifications when prompted
4. Fill in your name and last 4 digits of student ID (for marking queue)
5. Optionally attach a screenshot or file (drag & drop or click to browse)
6. Click "Join Queue"
7. Wait for your turn - you'll receive notifications as you move up

### For TAs

1. Log in with a TA-allowlisted email
2. See both queues with all students in a combined dashboard
3. Click "Next Marking" or "Next Question" to call the next student
4. Expand queue items to view attached files and image previews
5. Use the controls to cancel calls, push back, or remove students

## Tech Stack

- **Frontend**: React 19 + Vite + Tailwind CSS
- **Backend**: Express + Socket.IO + better-sqlite3
- **Auth**: Email-based OTP with session tokens
- **Email**: Nodemailer (SMTP)
- **File Storage**: Local filesystem (default) or S3-compatible cloud storage

## Environment Variables

### Frontend

Create a `.env` file in the root:

```
VITE_SOCKET_URL=http://localhost:3001
```

For production, set this to your server URL.

### Backend

The following environment variables are set when running the server (see [Start the Server](#2-start-the-server)):

| Variable | Required | Description |
|---|---|---|
| `TA_EMAIL_ALLOWLIST` | No | Comma-separated list of emails allowed to log in as TA |
| `APP_BASE_URL` | No | Base URL of the frontend (used in email links). Defaults to `http://localhost:5173` |
| `SMTP_HOST` | No | SMTP server hostname (e.g. `smtp.gmail.com`) |
| `SMTP_PORT` | No | SMTP server port (e.g. `587`) |
| `SMTP_USER` | No | SMTP username / email |
| `SMTP_PASS` | No | SMTP password or app password |
| `SMTP_FROM` | No | Sender address for emails (e.g. `ECE Queue <you@gmail.com>`) |
| `S3_BUCKET` | No | S3 bucket name for file storage |
| `S3_REGION` | No | S3 region (e.g. `us-east-1`, or `auto` for Cloudflare R2) |
| `S3_ENDPOINT` | No | S3 endpoint URL |
| `S3_ACCESS_KEY_ID` | No | S3 access key |
| `S3_SECRET_ACCESS_KEY` | No | S3 secret key |

> All variables are optional. Without SMTP configured, email features (OTP login, turn notifications) are disabled. Without S3 configured, file uploads are stored locally in `server/uploads/`.

### File Storage

File uploads support two storage backends:

**Local storage (default)** — files are saved to `server/uploads/`. No configuration needed. This is suitable for development and single-server deployments.

**S3-compatible cloud storage** — set all five `S3_*` environment variables to enable. Works with:

- **AWS S3** — set `S3_ENDPOINT` to `https://s3.<region>.amazonaws.com`
- **Cloudflare R2** (recommended, free 10GB) — set `S3_REGION=auto` and `S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com`
- **MinIO** or any other S3-compatible service

Supported file types: PNG, JPEG, GIF, WebP, PDF. Max file size: 5 MB.

## Deployment

### Frontend (Vercel/Netlify)

```bash
npm run build
```

Upload the `dist` folder.

### Backend (Railway/Render/Fly.io)

Deploy the `server` folder as a Node.js application. Set the environment variables listed above as needed.

## License

MIT - Feel free to use and modify for your TA sessions!

## Contributing

PRs welcome! This is an open-source project for educational use.


## Disclaimer

The majority of the code in this project is generated by large language models (LLMs). Please review and use at your own risk, and verify critical logic as needed.