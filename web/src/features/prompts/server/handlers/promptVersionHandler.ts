import { logger } from "@langfuse/shared/src/server";
import { z } from "zod";

import { withMiddlewares } from "@/src/features/public-api/server/withMiddlewares";
import { createAuthedProjectAPIRoute } from "@/src/features/public-api/server/createAuthedProjectAPIRoute";
import { updatePrompt } from "@/src/features/prompts/server/actions/updatePrompts";
import { auditLog } from "@/src/features/audit-logs/auditLog";
import { deletePromptVersion } from "@/src/features/prompts/server/actions/deletePromptVersion";

const UpdatePromptBodySchema = z.object({
  newLabels: z
    .array(z.string())
    .refine((labels) => !labels.includes("latest"), {
      message: "Label 'latest' is always assigned to the latest prompt version",
    }),
});

const DeletePromptResponseSchema = z.object({
  deletedPromptId: z.string(),
});

export const promptVersionHandler = withMiddlewares({
  PATCH: createAuthedProjectAPIRoute({
    name: "Update Prompt",
    bodySchema: UpdatePromptBodySchema,
    responseSchema: z.any(),
    fn: async ({ body, req, auth }) => {
      const { newLabels } = UpdatePromptBodySchema.parse(body);
      const { promptName, promptVersion } = req.query;

      const prompt = await updatePrompt({
        promptName: promptName as string,
        projectId: auth.scope.projectId,
        promptVersion: Number(promptVersion),
        newLabels,
      });

      await auditLog({
        action: "update",
        resourceType: "prompt",
        resourceId: prompt.id,
        projectId: auth.scope.projectId,
        orgId: auth.scope.orgId,
        apiKeyId: auth.scope.apiKeyId,
      });

      logger.info(`Prompt updated ${JSON.stringify(prompt)}`);

      return prompt;
    },
  }),
  DELETE: createAuthedProjectAPIRoute({
    name: "Delete Prompt Version",
    responseSchema: DeletePromptResponseSchema,
    fn: async ({ req, auth }) => {
      const projectId = auth.scope.projectId;
      const { promptName, promptVersion } = req.query;

      const deletedPrompt = await deletePromptVersion({
        promptName: promptName as string,
        projectId: projectId,
        promptVersion: Number(promptVersion),
        orgId: auth.scope.orgId,
        apiKeyId: auth.scope.apiKeyId,
      });

      return {
        deletedPromptId: deletedPrompt.id,
      };
    },
  }),
});
