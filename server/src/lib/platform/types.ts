export type NotificationType = "info" | "warning" | "success" | "action_required";
export type LinkType = "related" | "created_from" | "blocks" | "resolves";

export interface NotifyParams {
  app_slug: string;
  type: NotificationType;
  title: string;
  body?: string;
  link?: string;
  entity_type?: string;
  entity_id?: string;
  from_user_id?: string;
}

export interface NotifyErrorParams {
  title: string;
  body?: string;
  link?: string;
}

export interface LinkEntitiesParams {
  from: { app: string; entity: string; id: string };
  to:   { app: string; entity: string; id: string };
  type: LinkType;
}

export interface ManifestNotificationDef {
  type: NotificationType;
  title: string | ((payload: Record<string, unknown>) => string);
  body?:  string | ((payload: Record<string, unknown>) => string);
  link?:  string | ((payload: Record<string, unknown>) => string);
}

export interface ManifestSubscription {
  event:   string;
  source:  string;
  handler: string;
}

export interface AppManifest {
  slug:  string;
  name:  string;
  emits: string[];
  subscribes: ManifestSubscription[];
  notifications: Record<string, ManifestNotificationDef>;
  entities: {
    reads:  string[];
    writes: string[];
  };
  errors: {
    default_handler_role: "owner" | "admin";
    examples: string[];
  };
}
