/**
 * Install image-handling instructions for each agent type.
 *
 * When a Discord user sends images, discode downloads them and appends
 * `[image:/absolute/path]` markers to the message text. These instructions
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
 *   - Generic: Places a `.discode/IMAGE_INSTRUCTIONS.md` that the agent
 *     can discover via file listing or be told about.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/** Marker that we embed so we can detect whether we've already injected. */
const DISCODE_IMAGE_MARKER = '<!-- discode:image-instructions -->';

/**
 * The instruction text that teaches agents how to handle `[image:...]` markers.
 */
export function getImageInstructionText(projectPath?: string): string {
  const imagesDir = projectPath
    ? `${projectPath}/.discode/images/`
    : '.discode/images/';

  return `${DISCODE_IMAGE_MARKER}
## Discord Image Attachments

### Receiving images from Discord

When a message from Discord contains image attachments, the images are
automatically downloaded and referenced with markers in the following format:

\`\`\`
[image:/absolute/path/to/image.png]
\`\`\`

**When you see \`[image:...]\` markers, you MUST:**
1. Use your file reading tool (e.g. \`Read\`, \`view\`, \`cat\`) to open the
   image file at the given absolute path.
2. Analyze or describe the image content as requested by the user.
3. If multiple images are attached, read and process all of them.

The images are stored under the project's \`${imagesDir}\` directory.
Supported formats: PNG, JPEG, GIF, WebP.

### The \`${imagesDir}\` directory — ALWAYS CHECK HERE FIRST

This directory is the **shared image workspace** for both receiving and sending
images through Discord.

**IMPORTANT:** When the user asks you to send, show, or share any image, picture,
diagram, or visual content, you **MUST list the files in \`${imagesDir}\` first**
before doing anything else (including web searches). The file the user is referring
to is almost certainly already in this directory. Only search externally if the
requested image does not exist here.

### Sending images to Discord

When you generate or create an image (e.g. charts, diagrams, screenshots,
rendered output), **always save it to \`${imagesDir}\`**. Any image file whose
absolute path appears in your response text is automatically sent as a Discord
file attachment.

Supported formats: PNG, JPEG, GIF, WebP, SVG, BMP.

**To send a generated image to Discord:**
1. Save the image file to \`${imagesDir}\`.
2. Mention the absolute file path in your response text.
   For example: "Here is the chart I generated: \`${imagesDir}chart.png\`"
3. The system will automatically extract the path and attach the image
   to the Discord message.

**Tips:**
- Use descriptive filenames (e.g. \`architecture-diagram.png\`, not \`output.png\`).
- Always use absolute paths so the system can locate and send the file.
- You can send multiple images by mentioning multiple paths in your response.
`;
}

/**
 * Install image instructions for Claude Code.
 *
 * Claude Code automatically reads CLAUDE.md files in the project tree.
 * We write to `{projectPath}/.discode/CLAUDE.md` so we don't interfere
 * with the user's own CLAUDE.md at the project root.
 */
export function installImageInstructionForClaude(projectPath: string): void {
  const discodeDir = join(projectPath, '.discode');
  mkdirSync(discodeDir, { recursive: true });

  const claudeMdPath = join(discodeDir, 'CLAUDE.md');
  const instruction = getImageInstructionText(projectPath);

  if (existsSync(claudeMdPath)) {
    const existing = readFileSync(claudeMdPath, 'utf-8');
    if (existing.includes(DISCODE_IMAGE_MARKER)) return; // already installed
    writeFileSync(claudeMdPath, existing + '\n' + instruction, 'utf-8');
  } else {
    writeFileSync(claudeMdPath, instruction, 'utf-8');
  }
}

/**
 * Install image instructions for OpenCode.
 *
 * OpenCode reads `{projectPath}/.opencode/instructions.md` automatically
 * as system-level instructions.
 */
export function installImageInstructionForOpencode(projectPath: string): void {
  const opencodeDir = join(projectPath, '.opencode');
  mkdirSync(opencodeDir, { recursive: true });

  const instructionsPath = join(opencodeDir, 'instructions.md');
  const instruction = getImageInstructionText(projectPath);

  if (existsSync(instructionsPath)) {
    const existing = readFileSync(instructionsPath, 'utf-8');
    if (existing.includes(DISCODE_IMAGE_MARKER)) return; // already installed
    writeFileSync(instructionsPath, existing + '\n' + instruction, 'utf-8');
  } else {
    writeFileSync(instructionsPath, instruction, 'utf-8');
  }
}

/**
 * Install image instructions for Codex.
 *
 * Codex reads AGENTS.md at each directory level along the path from the
 * git root to the working directory.  It does NOT look inside `.codex/`
 * subdirectories, so we must write to `{projectPath}/AGENTS.md` directly.
 */
export function installImageInstructionForCodex(projectPath: string): void {
  const agentsMdPath = join(projectPath, 'AGENTS.md');
  const instruction = getImageInstructionText(projectPath);

  if (existsSync(agentsMdPath)) {
    const existing = readFileSync(agentsMdPath, 'utf-8');
    if (existing.includes(DISCODE_IMAGE_MARKER)) return; // already installed
    writeFileSync(agentsMdPath, existing + '\n' + instruction, 'utf-8');
  } else {
    writeFileSync(agentsMdPath, instruction, 'utf-8');
  }
}

/**
 * Install image instructions for any generic agent.
 *
 * Places the instructions at `{projectPath}/.discode/IMAGE_INSTRUCTIONS.md`
 * where agents can discover them.
 */
export function installImageInstructionGeneric(projectPath: string): void {
  const discodeDir = join(projectPath, '.discode');
  mkdirSync(discodeDir, { recursive: true });

  const instructionPath = join(discodeDir, 'IMAGE_INSTRUCTIONS.md');
  const instruction = getImageInstructionText(projectPath);

  if (existsSync(instructionPath)) {
    const existing = readFileSync(instructionPath, 'utf-8');
    if (existing.includes(DISCODE_IMAGE_MARKER)) return;
  }

  writeFileSync(instructionPath, instruction, 'utf-8');
}

/**
 * Install image-handling instructions appropriate for the given agent type.
 */
export function installImageInstruction(projectPath: string, agentType: string): void {
  switch (agentType) {
    case 'claude':
      installImageInstructionForClaude(projectPath);
      break;
    case 'opencode':
      installImageInstructionForOpencode(projectPath);
      break;
    case 'codex':
      installImageInstructionForCodex(projectPath);
      break;
    default:
      installImageInstructionGeneric(projectPath);
      break;
  }
}
