import type { Credential } from "@earendil-works/pi-ai";
import type { Connection, ModelSelection } from "../../shared/config";

export type LoginConnectionMetadataField =
  | "email"
  | "expiresAt"
  | "cursorBackendUrl"
  | "refreshFailedAt";

export type LoginMutation =
  | {
      kind: "auth";
      alias: string;
      before: Credential | undefined;
      written: Credential | undefined;
    }
  | {
      kind: "connection-add";
      connectionId: string;
      written: Connection;
    }
  | {
      kind: "connection-field";
      connectionId: string;
      field: LoginConnectionMetadataField;
      before: string | undefined;
      written: string | undefined;
    }
  | {
      kind: "selection";
      field: "agent" | "scoring";
      before: ModelSelection | null;
      written: ModelSelection | null;
    };

export type LoginMutationJournal = LoginMutation[];
