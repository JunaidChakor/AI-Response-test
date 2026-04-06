# Render Casting Service

## Deploy on Render

1. Upload these files to a GitHub repo.
2. In Render, create a new **Web Service** from that repo.
3. Use:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
4. Add environment variable:
   - `GEMINI_API_KEY=your_key_here`

## API

### Start job
`POST /jobs`

JSON body: same fields you were sending from Bubble.

### Check job
`GET /jobs/:id`

## Important
This starter stores jobs in memory using `Map()`.
If the service restarts, jobs are lost.
Use Postgres/Redis later for production.
