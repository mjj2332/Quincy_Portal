# Research — Kanban Libraries and Trello

**Conclusion:** Trello does not provide an embeddable open-source board/comment implementation for Quincy. Keep Quincy data; modernize the existing board with a headless DnD engine.

## Trello

Atlassian's official Trello developer surface centers on:

- REST API;
- Power-Ups that extend Trello itself;
- Trello-managed objects and authorization.

Using Trello's API would make Trello the data/platform dependency rather than provide reusable board source for Quincy.

Useful conceptual pattern:

- comments and system changes can be presented together as a card activity stream;
- in Trello APIs, comments are represented as comment actions.

Quincy can copy the product pattern while keeping its own data model.

## `react-beautiful-dnd`

Historically associated with Trello-like React boards, but no longer a recommended new foundation. Do not choose it for the revamp.

## Atlassian Pragmatic Drag and Drop

Strengths:

- low-level, headless and framework-agnostic;
- powers Trello, Jira and Confluence;
- Trello-like board examples;
- performance and virtualization focus;
- optional visual/accessibility packages.

Caveat:

- examples do not automatically provide Quincy's required accessibility, data model, persistence or conflict behavior;
- introducing it would overlap with existing dnd-kit.

Use only as a comparison candidate if dnd-kit fails a measured requirement.

## dnd-kit

Strengths:

- already installed in Quincy;
- multiple sortable containers;
- pointer/touch/keyboard sensors;
- customizable collision logic;
- DragOverlay recommended for scrollable/multi-container movement;
- full visual ownership.

Recommended first choice for board modernization.

## Full self-hosted board applications

Wekan, PLANKA and similar tools are complete applications rather than headless components. Embedding them would create a second product, auth/data model and deployment stack.

Not recommended for Quincy.

## Complete Kanban UI widgets

Commercial/open-source widgets may provide faster generic CRUD, but impose their own visuals/data assumptions and do not solve Quincy permissions, project pipeline, activity, comments or conflict handling.

Not recommended before testing the existing board with dnd-kit.

## Quincy-specific conclusion

- Current board card = project.
- Current column = project pipeline stage.
- Preserve `priority`, `boardPosition`, stage rules and direct project links.
- Reuse project discussion in the card detail.
- Add dnd-kit and conflict-safe persistence through a bounded modernization slice.
- Keep a non-drag “Move to…” control.

## Official sources

- https://developer.atlassian.com/cloud/trello/
- https://developer.atlassian.com/cloud/trello/guides/rest-api/api-introduction/
- https://developer.atlassian.com/cloud/trello/rest/
- https://github.com/atlassian/pragmatic-drag-and-drop
- https://atlassian.design/components/pragmatic-drag-and-drop/examples
- https://docs.dndkit.com/presets/sortable
- https://docs.dndkit.com/api-documentation/draggable/drag-overlay
