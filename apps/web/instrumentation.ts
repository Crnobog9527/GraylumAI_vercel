/**
 * This file is used to register instrumentation for the application.
 * It loads Sentry configuration for server-side and edge runtimes.
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = async (
  err: { digest: string } & Error,
  request: {
    path: string;
    method: string;
    headers: { [key: string]: string };
  },
  context: {
    routerKind: "Pages Router" | "App Router";
    routePath: string;
    routeType: "render" | "route" | "action" | "middleware";
    renderSource:
      | "react-server-components"
      | "react-server-components-payload"
      | "server-rendering";
    revalidateReason: "on-demand" | "stale" | undefined;
    renderType: "dynamic" | "dynamic-resume";
  }
) => {
  // Import Sentry dynamically to avoid issues with edge runtime
  const Sentry = await import("@sentry/nextjs");

  Sentry.captureException(err, {
    mechanism: {
      type: "instrument",
      handled: false,
    },
    tags: {
      router_kind: context.routerKind,
      route_path: context.routePath,
      route_type: context.routeType,
    },
    extra: {
      request_path: request.path,
      request_method: request.method,
      render_source: context.renderSource,
      revalidate_reason: context.revalidateReason,
    },
  });
};
