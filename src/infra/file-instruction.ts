/**
 * Install file-handling instructions for each agent type.
 *
 * When a Discord user sends files, discode downloads them and appends
 * `[file:/absolute/path]` markers to the message text. These instructions
 * teach agents how to recognize and read those markers.
 *
 * Injection strategies per agent:
 *   - Claude Code: Writes a CLAUDE.md snippet in the project's
 *     `.discode/` directory and references it via `--append-system-prompt`.
 *     Falls back to CLAUDE.md at project root if the agent will read it
 *     automatically.  We use `.discode/CLAUDE.md` so we don't pollute the
 *     user's own CLAUDE.md.
 *   - OpenCode: Appends an instruction block to `.opencode/instructions.md`
 *     in the project directory (OpenCode reads this automatically).
 *   - Codex: Appends an instruction block to `AGENTS.md` at the project
 *     root (Codex reads AGENTS.md files at each directory level along
 *     the tree, but NOT inside `.codex/` subdirectories).
 *   - Generic: Places a `.discode/FILE_INSTRUCTIONS.md` that the agent
 *     can discover via file listing or be told about.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/** Marker that we embed so we can detect whether we've already injected. */
const DISCODE_FILE_MARKER = '<!-- discode:file-instructions -->';

/** Legacy marker for backward-compatible idempotency checks. */
const DISCODE_IMAGE_MARKER_LEGACY = '<!-- discode:image-instructions -->';

/**
 * Check whether a file already contains either the current or legacy marker.
 */
function hasMarker(content: string): boolean {
  return content.includes(DISCODE_FILE_MARKER) || content.includes(DISCODE_IMAGE_MARKER_LEGACY);
}

/**
 * The instruction text that teaches agents how to handle `[file:...]` markers.
 */
export function getFileInstructionText(projectPath?: string): string {
  const filesDir = projectPath
    ? `${projectPath}/.discode/files/`
    : '.discode/files/';

  return `${DISCODE_FILE_MARKER}
## Discord File Attachments

### Receiving files from Discord

When a message from Discord contains file attachments, the files are
automatically downloaded and referenced with markers in the following format:

\`\`\`
[file:/absolute/path/to/file.pdf]
\`\`\`

**When you see \`[file:...]\` markers, you MUST:**
1. Use your file reading tool (e.g. \`Read\`, \`view\`, \`cat\`) to open the
   file at the given absolute path.
2. Analyze or describe the file content as requested by the user.
3. If multiple files are attached, read and process all of them.

The files are stored under the project's \`${filesDir}\` directory.
Supported formats: PNG, JPEG, GIF, WebP, PDF, DOCX, PPTX, XLSX, CSV, JSON, TXT.

### The \`${filesDir}\` directory — ALWAYS CHECK HERE FIRST

This directory is the **shared file workspace** for both receiving and sending
files through Discord.

**IMPORTANT:** When the user asks you to send, show, or share any file, image,
document, or visual content, you **MUST list the files in \`${filesDir}\` first**
before doing anything else (including web searches). The file the user is referring
to is almost certainly already in this directory. Only search externally if the
requested file does not exist here.

### Sending files to Discord

When you generate or create a file (e.g. charts, diagrams, screenshots,
rendered output, PDFs, documents), **always save it to \`${filesDir}\`**. Any
file whose absolute path appears in your response text is automatically sent
as a Discord file attachment.

Supported formats: PNG, JPEG, GIF, WebP, SVG, BMP, PDF, DOCX, PPTX, XLSX, CSV, JSON, TXT.

**To send a generated file to Discord:**
1. Save the file to \`${filesDir}\`.
2. Mention the absolute file path in your response text.
   For example: "Here is the chart I generated: \`${filesDir}chart.png\`"
3. The system will automatically extract the path and attach the file
   to the Discord message.

**Tips:**
- Use descriptive filenames (e.g. \`architecture-diagram.png\`, not \`output.png\`).
- Always use absolute paths so the system can locate and send the file.
- You can send multiple files by mentioning multiple paths in your response.

### Python dependencies for document processing

Processing PDF, DOCX, PPTX, XLSX files may require Python libraries (e.g.
\`pymupdf\`, \`python-pptx\`, \`openpyxl\`, \`python-docx\`). When you need a
library that is not installed, **always use a venv**:

\`\`\`bash
python3 -m venv ${filesDir}.venv
source ${filesDir}.venv/bin/activate
pip install <package>
\`\`\`

Reuse the existing venv if \`${filesDir}.venv\` already exists. Never install
packages globally with \`pip install\` outside of a venv.
`;
}

/**
 * Install file instructions for Claude Code.
 *
 * Claude Code automatically reads CLAUDE.md files in the project tree.
 * We write to `{projectPath}/.discode/CLAUDE.md` so we don't interfere
 * with the user's own CLAUDE.md at the project root.
 */
export function installFileInstructionForClaude(projectPath: string): void {
  const discodeDir = join(projectPath, '.discode');
  mkdirSync(discodeDir, { recursive: true });

  const claudeMdPath = join(discodeDir, 'CLAUDE.md');
  const instruction = getFileInstructionText(projectPath);

  if (existsSync(claudeMdPath)) {
    const existing = readFileSync(claudeMdPath, 'utf-8');
    if (hasMarker(existing)) return; // already installed
    writeFileSync(claudeMdPath, existing + '\n' + instruction, 'utf-8');
  } else {
    writeFileSync(claudeMdPath, instruction, 'utf-8');
  }
}

/**
 * Install file instructions for OpenCode.
 *
 * OpenCode reads `{projectPath}/.opencode/instructions.md` automatically
 * as system-level instructions.
 */
export function installFileInstructionForOpencode(projectPath: string): void {
  const opencodeDir = join(projectPath, '.opencode');
  mkdirSync(opencodeDir, { recursive: true });

  const instructionsPath = join(opencodeDir, 'instructions.md');
  const instruction = getFileInstructionText(projectPath);

  if (existsSync(instructionsPath)) {
    const existing = readFileSync(instructionsPath, 'utf-8');
    if (hasMarker(existing)) return; // already installed
    writeFileSync(instructionsPath, existing + '\n' + instruction, 'utf-8');
  } else {
    writeFileSync(instructionsPath, instruction, 'utf-8');
  }
}

/**
 * Install file instructions for Codex.
 *
 * Codex reads AGENTS.md at each directory level along the path from the
 * git root to the working directory.  It does NOT look inside `.codex/`
 * subdirectories, so we must write to `{projectPath}/AGENTS.md` directly.
 */
export function installFileInstructionForCodex(projectPath: string): void {
  const agentsMdPath = join(projectPath, 'AGENTS.md');
  const instruction = getFileInstructionText(projectPath);

  if (existsSync(agentsMdPath)) {
    const existing = readFileSync(agentsMdPath, 'utf-8');
    if (hasMarker(existing)) return; // already installed
    writeFileSync(agentsMdPath, existing + '\n' + instruction, 'utf-8');
  } else {
    writeFileSync(agentsMdPath, instruction, 'utf-8');
  }
}

/**
 * Install file instructions for any generic agent.
 *
 * Places the instructions at `{projectPath}/.discode/FILE_INSTRUCTIONS.md`
 * where agents can discover them.
 */
export function installFileInstructionGeneric(projectPath: string): void {
  const discodeDir = join(projectPath, '.discode');
  mkdirSync(discodeDir, { recursive: true });

  const instructionPath = join(discodeDir, 'FILE_INSTRUCTIONS.md');
  const instruction = getFileInstructionText(projectPath);

  if (existsSync(instructionPath)) {
    const existing = readFileSync(instructionPath, 'utf-8');
    if (hasMarker(existing)) return;
  }

  writeFileSync(instructionPath, instruction, 'utf-8');
}

/**
 * Install file-handling instructions appropriate for the given agent type.
 */
export function installFileInstruction(projectPath: string, agentType: string): void {
  switch (agentType) {
    case 'claude':
      installFileInstructionForClaude(projectPath);
      break;
    case 'opencode':
      installFileInstructionForOpencode(projectPath);
      break;
    case 'codex':
      installFileInstructionForCodex(projectPath);
      break;
    default:
      installFileInstructionGeneric(projectPath);
      break;
  }
}
