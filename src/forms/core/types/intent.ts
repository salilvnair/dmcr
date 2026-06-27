export type DmcrIntent =
  | "ADD_COLUMN"
  | "DROP_COLUMN"
  | "CREATE_TABLE"
  | "ALTER_TABLE"
  | "CREATE_INDEX"
  | "SEED_DATA"
  | "MODIFY_FUNCTION"
  | "UNKNOWN";

export type DmcrRisk =
  | "ADD_COLUMN_DEFAULT"
  | "ADD_COLUMN_NOT_NULL"
  | "TABLE_REWRITE"
  | "LOCK_ESCALATION"
  | "AMBIGUOUS";

export interface DmcrIntentResult {
  intent: DmcrIntent;
  object?: {
    table?: string;
    column?: string;
    index?: string;
    function?: string;
    dataType?: string;
  };
  risks: DmcrRisk[];
  confidence: number;
}
