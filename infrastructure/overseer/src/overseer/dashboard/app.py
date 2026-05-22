"""
Overseer Dashboard - FastAPI Application

Provides REST API endpoints for the Overseer multi-agent monitoring dashboard.
"""

import asyncio
import json
import sqlite3
from pathlib import Path
from typing import AsyncGenerator, Optional

from fastapi import FastAPI, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from jinja2 import Environment, FileSystemLoader
from sse_starlette.sse import EventSourceResponse

from pydantic import BaseModel

from overseer.server import (
    DB_PATH,
    list_agents,
    detect_state,
    dispatch_task,
    send_to_agent,
    _heartbeat_registry,
    extract_team,
)

app = FastAPI(
    title="Overseer Dashboard",
    version="0.1.0",
    description="Real-time multi-agent monitoring interface",
)

# CORS for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Jinja2 template setup
TEMPLATES_DIR = Path(__file__).parent / "templates"
jinja_env = Environment(
    loader=FileSystemLoader(TEMPLATES_DIR),
    autoescape=True,
)


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    """Serve the dashboard HTML page."""
    template = jinja_env.get_template("index.html")
    return template.render()


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok"}


@app.get("/api/agents")
async def get_agents(request: Request):
    """Get all agents with their current state.

    Returns HTML partials when called via htmx (HX-Request header),
    or JSON for programmatic API access.
    """
    agents = list_agents()
    result = []
    for agent in agents:
        state_info = detect_state(agent)
        heartbeat = _heartbeat_registry.get(agent, {})
        result.append({
            "name": agent,
            "state": state_info.get("state", "unknown"),
            "confidence": state_info.get("confidence", "none"),
            "team_id": extract_team(agent),
            "last_heartbeat": heartbeat.get("timestamp"),
        })

    # Check for htmx request via HX-Request header
    if request.headers.get("HX-Request"):
        # Render agent cards as HTML partials
        template = jinja_env.get_template("partials/agent_card.html")
        html_parts = []
        for agent_data in result:
            html_parts.append(template.render(agent=agent_data))
        return HTMLResponse(content="\n".join(html_parts))

    return result


@app.get("/api/tasks")
async def get_tasks(request: Request, team_id: Optional[str] = None):
    """Get pending tasks, optionally filtered by team.

    Returns HTML partial when called via htmx (HX-Request header),
    otherwise returns JSON.
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    query = "SELECT id, content, timestamp FROM messages WHERE type = 'task_assign'"
    params = []
    if team_id:
        query += " AND team_id = ?"
        params.append(team_id)
    query += " ORDER BY id DESC LIMIT 50"

    cursor.execute(query, params)
    rows = cursor.fetchall()
    conn.close()

    tasks = []
    for row in rows:
        try:
            payload = json.loads(row["content"])
            tasks.append({
                "task_id": payload.get("task_id") or "",
                "description": payload.get("description", "")[:200],
                "assigned_to": payload.get("assigned_to"),
                "priority": payload.get("priority", "medium"),
                "timestamp": row["timestamp"],
            })
        except json.JSONDecodeError:
            continue

    # Return HTML partial for htmx requests
    if request.headers.get("HX-Request"):
        template = jinja_env.get_template("partials/task_queue.html")
        html = template.render(tasks=tasks)
        return HTMLResponse(content=html)

    return tasks


class TaskDispatchRequest(BaseModel):
    """Request body for task dispatch."""
    worker: str
    task_id: str
    description: str
    priority: str = "medium"


@app.post("/api/tasks")
async def create_task(request: TaskDispatchRequest):
    """Dispatch a new task to a worker."""
    # Extract director from worker name (assume same team)
    team_id = extract_team(request.worker)
    if not team_id:
        return {
            "status": "error",
            "error": f"Worker '{request.worker}' has no team assignment (requires numeric suffix like 'claude-3')",
            "worker": request.worker
        }

    director = f"dashboard-{team_id}"

    result = dispatch_task(
        director=director,
        worker=request.worker,
        task_id=request.task_id,
        description=request.description,
        priority=request.priority
    )
    return result


async def relay_event_generator(
    team_id: Optional[str] = None,
) -> AsyncGenerator[dict, None]:
    """Generate SSE events for new relay messages."""
    last_id = 0

    # Get current max ID to start from
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("SELECT MAX(id) FROM messages")
        result = cursor.fetchone()[0]
        last_id = result if result else 0
        conn.close()
    except sqlite3.OperationalError:
        # Database may not exist yet
        pass

    while True:
        try:
            conn = sqlite3.connect(DB_PATH)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()

            query = "SELECT id, agent, content, type, timestamp FROM messages WHERE id > ?"
            params = [last_id]
            if team_id:
                query += " AND team_id = ?"
                params.append(team_id)
            query += " ORDER BY id"

            cursor.execute(query, params)
            rows = cursor.fetchall()
            conn.close()

            for row in rows:
                last_id = row["id"]
                yield {
                    "event": "message",
                    "data": json.dumps({
                        "id": row["id"],
                        "agent": row["agent"],
                        "type": row["type"],
                        "content": row["content"][:500],
                        "timestamp": row["timestamp"],
                    }),
                }

        except sqlite3.OperationalError:
            # Database may not exist or be locked
            pass

        await asyncio.sleep(1)  # Poll every 1 second


@app.get("/api/relay/stream")
async def relay_stream(
    team_id: Optional[str] = Query(default=None, description="Filter by team ID"),
):
    """SSE stream of relay messages."""
    return EventSourceResponse(relay_event_generator(team_id))


# Executor activation prompt for waking agents
EXECUTOR_PROMPT = "ACTIVATION: You are EXECUTOR. Monitor relay for tasks."


@app.post("/api/agents/{name}/wake")
async def wake_agent(name: str):
    """Send activation message to wake an agent."""
    result = send_to_agent(
        agent=name,
        message=EXECUTOR_PROMPT,
        interrupt_if_busy=False,
        execute=True,
        verify=True
    )
    return {
        "status": result.get("status", "unknown"),
        "agent": name,
        "message_sent": EXECUTOR_PROMPT[:50] + "...",
        "details": result
    }
