import {
  id,
  type ClientId,
  type JobId,
  type OperationResult,
  type RequestContext,
  type GeometryQuantity,
  type PhysicalDispatch,
} from "../packages/core/src";
const client: ClientId = id("client", "c");
// @ts-expect-error identity families must not be interchangeable
const job: JobId = client;
// @ts-expect-error unit must be explicit and supported
const quantity: GeometryQuantity = { value: 10, unit: "guess" };
// @ts-expect-error physical execution cannot be classified by transport success
const outcome: OperationResult["executionOutcome"] = "accepted";
const context: RequestContext = {
  version: 1,
  clientId: client,
  requestId: id("request", "r"),
  sessionId: null,
  projectId: null,
  documentId: null,
  instanceId: null,
  purpose: null,
};
// @ts-expect-error no credential store or runtime state in request context
context.credentialsPath = "/private";
const dispatch: PhysicalDispatch = {
  // @ts-expect-error dispatch accepts a request DTO, not a socket/runtime object
  dispatch: async (socket: { fd: number }) => socket,
  // @ts-expect-error missing observation is not a successful DTO
  observe: async () => null,
};
void [job, quantity, outcome, context, dispatch];
