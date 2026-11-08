import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import type { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { actorKey, ddb, movieKey, type Role, tableName } from "../shared/db";
import { isResponse, parseJsonObject, response } from "../shared/http";
import { logRequest } from "../shared/request-logger";

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  logRequest(event);

  const body = parseJsonObject(event);
  if (isResponse(body)) return body;

  const { movieId, actorId, roleName, roleDescription } = body;
  if (
    !isPositiveInteger(movieId) ||
    !isPositiveInteger(actorId) ||
    !isNonEmptyString(roleName) ||
    !isNonEmptyString(roleDescription)
  ) {
    return response(400, {
      message:
        "Body must contain movieId and actorId (positive integers) and roleName and roleDescription (non-empty strings)",
    });
  }
  const role: Role = { movieId, actorId, roleName, roleDescription };

  try {
    // All-or-nothing: the movie and actor must exist, and the role must not already exist.
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: tableName,
              Key: { PK: movieKey(movieId), SK: movieKey(movieId) },
              ConditionExpression: "attribute_exists(PK)",
            },
          },
          {
            ConditionCheck: {
              TableName: tableName,
              Key: { PK: actorKey(actorId), SK: actorKey(actorId) },
              ConditionExpression: "attribute_exists(PK)",
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: { PK: movieKey(movieId), SK: actorKey(actorId), ...role },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
        ],
      })
    );
    return response(201, { message: "Role added", data: role });
  } catch (err) {
    if ((err as Error).name === "TransactionCanceledException") {
      // One reason per transaction item, in the same order as TransactItems above.
      const [movieCheck, actorCheck, rolePut] = (
        (err as TransactionCanceledException).CancellationReasons ?? []
      ).map((reason) => reason.Code === "ConditionalCheckFailed");
      if (movieCheck) return response(404, { message: `Movie ${movieId} not found` });
      if (actorCheck) return response(404, { message: `Actor ${actorId} not found` });
      if (rolePut) {
        return response(409, {
          message: `Actor ${actorId} already has a role in movie ${movieId}`,
        });
      }
    }
    console.error("DynamoDB error:", err);
    return response(500, { message: "Internal server error" });
  }
};
