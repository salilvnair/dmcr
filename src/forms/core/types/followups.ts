import { DmcrRisk } from "./intent";

export interface FollowUpOption {
  id: string;
  label: string;
}

export interface FollowUpQuestion {
  question: string;
  options: FollowUpOption[];
}

export const FOLLOW_UPS: Record<DmcrRisk, FollowUpQuestion> = {
  ADD_COLUMN_DEFAULT: {
    question:
      "This change adds a DEFAULT value which may rewrite the table and block reads.\n\nHow would you like to proceed?",
    options: [
      { id: "safe_split", label: "Generate safe split (recommended)" },
      { id: "generate_anyway", label: "Generate as-is with DEFAULT" },
      { id: "cancel", label: "Cancel" },
    ],
  },

  ADD_COLUMN_NOT_NULL: {
    question:
      "Adding NOT NULL may block writes if existing rows violate the constraint.\n\nProceed?",
    options: [
      { id: "safe_split", label: "Generate safe multi-step change" },
      { id: "generate_anyway", label: "Generate NOT NULL directly" },
      { id: "cancel", label: "Cancel" },
    ],
  },

  TABLE_REWRITE: {
    question:
      "This change may cause a full table rewrite.\n\nHow do you want to proceed?",
    options: [
      { id: "safe_split", label: "Generate safe plan" },
      { id: "generate_anyway", label: "Generate anyway" },
      { id: "cancel", label: "Cancel" },
    ],
  },

  LOCK_ESCALATION: {
    question:
      "This change may escalate locks and block traffic.\n\nProceed?",
    options: [
      { id: "safe_split", label: "Generate safer alternative" },
      { id: "generate_anyway", label: "Proceed anyway" },
      { id: "cancel", label: "Cancel" },
    ],
  },

  AMBIGUOUS: {
    question:
      "I could not confidently determine the SQL request intent.\n\nHow do you want to proceed?",
    options: [
      { id: "safe_split", label: "Generate a safe multi-step plan (recommended)" },
      { id: "generate_anyway", label: "Proceed anyway (generate best-effort change)" },
      { id: "clarify", label: "Clarify the request" },
      { id: "cancel", label: "Cancel" },
    ],
  },
};