/** Columns a person can hide on their lists (Settings → Table columns). Lead name, star and pin always show. */
export const TABLE_COLUMNS = {
  leads: [
    { id: "temperature", label: "Temperature" },
    { id: "status", label: "Stage" },
    { id: "niche", label: "Niche" },
    { id: "owner", label: "Owner", adminOnly: true },
    { id: "next", label: "Next follow-up" },
    { id: "created", label: "Created" },
    { id: "call", label: "Call button" },
    { id: "follow_up", label: "Follow-up button" },
    { id: "actions", label: "Notes button" },
  ],
  follow_ups: [
    { id: "stage", label: "Stage" },
    { id: "phone", label: "Phone" },
    { id: "assignee", label: "Assigned to", adminOnly: true },
    { id: "outcome", label: "Outcome" },
    { id: "reminder", label: "Reminder status" },
  ],
} as const satisfies Record<string, readonly { id: string; label: string; adminOnly?: boolean }[]>;

export type ColumnTable = keyof typeof TABLE_COLUMNS;
export const COLUMN_TABLES = Object.keys(TABLE_COLUMNS) as ColumnTable[];
