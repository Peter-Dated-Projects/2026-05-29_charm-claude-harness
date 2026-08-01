# Projects

A project is a scoped, deliverable slice of the architecture in [PLAN.md](../PLAN.md).
`PLAN.md` holds the long-term product vision; a project holds what is actually being built
now, which subsystem designs it draws on, and what has to be decided before it ships.

## Numbering

Projects are identified as `PRJ-NNN` and filed as `PRJ-NNN-kebab-case-title.md`, mirroring the
`TDD-NNN` convention in [tdds/](../tdds/README.md).

- **Numbers start at 001** and are assigned in creation order, not priority order.
- **A number is permanent.** It is never reused, renumbered, or reordered — including when a
  project is completed, cancelled, split, or superseded. Links and review artifacts refer to
  it by number.
- **Status lives inside the document**, never in the filename, so a project changing state
  does not churn its path or break inbound links.
- **A project is renamed freely; its number is not.** If the title changes, update the heading
  and leave the filename alone, or move the file and fix references in the same commit.
- **Superseding rather than editing** is the way to make a materially different bet: open a
  new number and mark the old one `Superseded by PRJ-NNN`.

Reference a project as `PRJ-001` in prose, and link it as
`[PRJ-001: Title](PRJ-001-kebab-title.md)`.

New project: copy [_TEMPLATE.md](_TEMPLATE.md) to the next free number, add a row below, and
add the project to the Current scope section of [tdds/README.md](../tdds/README.md).

## Active

| Project | Scope | Related TDDs |
| --- | --- | --- |
| | | |

State the build order in a sentence under the table, and name the critical path — the
subsystems everything downstream reads, which therefore cannot be validated late.

## Completed and superseded

| Project | Outcome |
| --- | --- |
| | |

Nothing is deleted from this file. A cancelled project keeps its number and its row.
