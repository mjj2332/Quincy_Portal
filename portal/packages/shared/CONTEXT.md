# Quincy production domain

The vocabulary of the studio's media pipeline: the projects that move through it, the
people assigned to them, and the two independent 1–5 scales that both render as stars.
`packages/shared` is where these concepts are typed, so this is where they are named.

## Language

### Work

**Project**:
One property shoot and everything delivered from it. The unit the pipeline moves.
_Avoid_: Job, listing, shoot

**Asset**:
One media file in a Project, at a known point in the RAW-to-delivered progression.
_Avoid_: Image, photo, file, frame

**Stage**:
The pipeline step a Project currently occupies. Keys are fixed in code; labels, active
state and display order are admin configuration.
_Avoid_: Status, state, column, phase

**Board**:
The cross-Project view that groups Projects into columns by Stage. One column per Stage.
_Avoid_: Kanban, dashboard, pipeline view

**Deadline**:
The civil-time commitment for a Project's delivery, held in the studio's timezone.
_Avoid_: Due date, ETA

### The two star scales

These are distinct concepts that share a 1–5 range, a nullable "unset", and a star
glyph. They are never the same number and never describe the same thing.

**Project priority**:
How urgently a Project should be worked, relative to other Projects. 1–5, or unset.
Set by hand; never derived.
_Avoid_: Rank, urgency, importance, weight, project rating

**Asset rating**:
The quality mark carried by a single Asset, read from its embedded capture metadata.
1–5, or unset. Describes one photograph, not the Project it belongs to.
_Avoid_: Score, quality, priority, stars

### People

**Editor**:
Someone assigned to a Project to produce its edited media.
_Avoid_: Retoucher, post

**External editor**:
An Editor outside the studio. Sees a deliberately narrowed view of a Project.
_Avoid_: Contractor, freelancer, outsourcer

**Photographer**:
Someone assigned to a Project to capture its RAW media. Assigned Projects only, and
only while the Project remains in the early Stages.
_Avoid_: Shooter, creative
