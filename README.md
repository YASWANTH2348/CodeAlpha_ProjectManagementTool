# Kivo — Project Management

A polished, responsive team project board built with Express, SQLite, WebSockets, and plain HTML, CSS, and JavaScript. Create projects, invite team members, assign and move tasks, discuss work in task comments, and receive live updates and notifications.

## Run locally

1. Install Node.js 20 or newer.
2. From this folder, run `npm install`.
3. Start the server with `npm start` (or `npm run dev` while developing).
4. Open [http://localhost:3002](http://localhost:3002).

The database is created in `data/kivo.sqlite` on first run. Demo login: **alex** / **demo12345**. Other seeded team members are **priya**, **marcus**, and **nina**; use their usernames to add them to a project.

Set `SESSION_SECRET` to a long, random value before deployment. The in-memory session store is intended for local demos; production should use a persistent session store and HTTPS.
