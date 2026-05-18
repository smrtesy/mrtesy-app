import { db } from "../../db";
import type { LinkEntitiesParams } from "./types";

export async function linkEntities(
  orgId: string,
  params: LinkEntitiesParams,
): Promise<void> {
  const { error } = await db.from("entity_links").upsert(
    {
      org_id:        orgId,
      source_app:    params.from.app,
      source_entity: params.from.entity,
      source_id:     params.from.id,
      target_app:    params.to.app,
      target_entity: params.to.entity,
      target_id:     params.to.id,
      link_type:     params.type,
    },
    { onConflict: "source_app,source_id,target_app,target_id" },
  );
  if (error) console.error("[platform.links]", error.message);
}

export async function getLinks(
  orgId: string,
  app: string,
  entityId: string,
): Promise<{ app: string; entity: string; id: string; type: string }[]> {
  const { data } = await db
    .from("entity_links")
    .select("*")
    .eq("org_id", orgId)
    .or(`and(source_app.eq.${app},source_id.eq.${entityId}),and(target_app.eq.${app},target_id.eq.${entityId})`);

  return (data ?? []).map((row) => {
    const isSource = row.source_app === app && row.source_id === entityId;
    return {
      app:    isSource ? row.target_app    : row.source_app,
      entity: isSource ? row.target_entity : row.source_entity,
      id:     isSource ? row.target_id     : row.source_id,
      type:   row.link_type,
    };
  });
}
