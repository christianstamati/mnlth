/// <reference path="../.sst/platform/config.d.ts" />

/**
 * Where alarms go. One SNS topic in the app's region for everything that
 * lives there (EC2, Lambda, RDS, log filters) and one in us-east-1 for the
 * Route 53 health check, whose metrics only exist in that region. Subscribe
 * both to Slack once in the console, through AWS Chatbot (now part of Amazon
 * Q Developer); the topic ARNs are stage outputs.
 *
 * Only production and staging create these: PR stages are torn down before
 * anyone would read an alarm, and every CloudWatch agent metric costs money.
 */

export interface Alerts {
  /** Alarm target for resources in the app's region. */
  topic: aws.sns.Topic
  /** Alarm target and provider for Route 53 health checks. */
  global: { topic: aws.sns.Topic; provider: aws.Provider }
}

export function createAlerts(name: string): Alerts {
  const topic = new aws.sns.Topic(`${name}Topic`, {
    displayName: `${$app.name} ${$app.stage} alerts`,
  })
  const provider = new aws.Provider(`${name}UsEast1`, { region: "us-east-1" })
  const globalTopic = new aws.sns.Topic(
    `${name}GlobalTopic`,
    { displayName: `${$app.name} ${$app.stage} alerts (us-east-1)` },
    { provider }
  )
  return { topic, global: { topic: globalTopic, provider } }
}

type AlarmArgs = Omit<
  aws.cloudwatch.MetricAlarmArgs,
  "alarmActions" | "okActions" | "name"
>

/**
 * A metric alarm that notifies the topic when it fires and again when it
 * clears. Missing data is treated as fine: a stopped instance or an idle
 * Lambda has no data points, and that is not what these alarms are for.
 */
export function metricAlarm(
  name: string,
  alerts: Alerts,
  args: AlarmArgs,
  opts?: $util.ComponentResourceOptions
): aws.cloudwatch.MetricAlarm {
  return new aws.cloudwatch.MetricAlarm(
    name,
    {
      treatMissingData: "notBreaching",
      ...args,
      alarmActions: [alerts.topic.arn, ...(args.alarmActions ?? [])],
      okActions: [alerts.topic.arn],
    },
    opts
  )
}

/**
 * Alarms for the Lambda that renders the web app: any invocation error, and
 * a p95 duration above `slowMs`. Both over five minutes.
 */
export function lambdaAlarms(
  name: string,
  alerts: Alerts,
  functionName: $util.Input<string>,
  slowMs = 3000
) {
  const dimensions = { FunctionName: functionName }
  metricAlarm(`${name}Errors`, alerts, {
    alarmDescription: "The web Lambda returned errors",
    namespace: "AWS/Lambda",
    metricName: "Errors",
    dimensions,
    statistic: "Sum",
    period: 300,
    evaluationPeriods: 1,
    threshold: 0,
    comparisonOperator: "GreaterThanThreshold",
  })
  metricAlarm(`${name}Slow`, alerts, {
    alarmDescription: `The web Lambda's p95 duration is above ${slowMs}ms`,
    namespace: "AWS/Lambda",
    metricName: "Duration",
    dimensions,
    extendedStatistic: "p95",
    period: 300,
    evaluationPeriods: 2,
    threshold: slowMs,
    comparisonOperator: "GreaterThanThreshold",
  })
}
