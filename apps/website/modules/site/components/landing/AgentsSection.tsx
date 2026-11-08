import { Link } from '@marmeon/react';
import { AGENT_SKILLS, AGENT_TOOLS, AGENTS_INSTALL_COMMAND, AGENTS_INSTALL_OUTPUT } from '../../agents.ts';
import { Terminal } from '../Terminal.tsx';

/** "Your coding agent sees what you see": the install command with its output, the skills and the MCP tools. */
export function AgentsSection() {
  return (
    <section className="agents" aria-labelledby="agents-title">
      <div className="landing-inner landing-columns">
        <div className="section-intro">
          <p className="section-label">Agents</p>
          <h2 id="agents-title">Your coding agent sees what you see.</h2>
          <p>
            It reads the app's real routes, the last server error and the docs of exactly the installed version instead of guessing. The MCP server starts only in development, and its tools look things up: none of them edits your code, and the one file they keep current is the generated <code>.marmeon/schema.json</code>.
          </p>
          <Terminal commands={[AGENTS_INSTALL_COMMAND]} output={AGENTS_INSTALL_OUTPUT} />
        </div>
        <div>
          <h3 className="group-label">Skills</h3>
          <ul className="agents-list">
            {AGENT_SKILLS.map(({ name, text }) => (
              <li key={name}>
                <code>{name}</code>
                <span>{text}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="landing-inner agents-tools">
        <h3 className="group-label">MCP tools</h3>
        <ul className="agents-list agents-list--grid">
          {AGENT_TOOLS.map(({ name, text }) => (
            <li key={name}>
              <code>{name}</code>
              <span>{text}</span>
            </li>
          ))}
        </ul>
        <p className="agents-clients">
          <code>agents:install</code> sets up Claude Code. Cursor and Copilot read the same skills, Codex with <code>--shared</code>, and each takes the server with one entry in its config. <Link href="/docs/agents">Coding agents</Link> · <Link href="/docs/mcp">MCP server</Link>
        </p>
      </div>
    </section>
  );
}
