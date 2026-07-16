# Issue tracker: Local Markdown

Issues and specs (including PRDs) live as Markdown files under `.scratch/`.

## Conventions

- Use one directory per feature: `.scratch/<feature-slug>/`.
- Store the feature spec at `.scratch/<feature-slug>/spec.md`.
- Store each implementation task in its own `.scratch/<feature-slug>/issues/<NN>-<slug>.md` file, numbered from `01`.
- Never combine all implementation tasks into a single tickets file.
- Record task state with a `Status:` line near the top of each task file.
- Append discussion history under a `## Comments` heading at the end of the file.

## Skill operations

- When a skill asks to publish a task, create the corresponding file under the feature directory, creating directories as needed.
- When a skill asks to fetch a task, read the referenced local Markdown file. The user will normally provide its path or task number.
