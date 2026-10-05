// 把任务状态合成"上线路线图"的站点状态。站点定义在 stations.json；纯函数，便于测试。

export const STATION_STATUS = { done: '已到站', doing: '正在做', todo: '还没到' };

const TASK_WORDS = { 已完成: '做完了', 实施中: '在做', 方案中: '在出方案', 被阻塞: '还没开始', 未开始: '还没开始', 已关闭: '不做了' };

function afterText(task, station, stationOf, taskOf) {
  const others = task.deps
    .map((dep) => stationOf.get(dep))
    .filter((target) => target && target !== station && target.status !== 'done')
    .sort((a, b) => b.index - a.index);
  if (others.length) return `排在「${others[0].name}」之后`;
  const sameStation = task.deps.map((dep) => taskOf.get(dep)).find((dep) => dep && stationOf.get(dep.name) === station);
  return sameStation ? `要等本站的「${sameStation.plain.replace(/[。.]$/, '')}」先做完` : '';
}

export function buildStations(stationData, report) {
  const byName = new Map(report.tasks.map((task) => [task.name, task]));
  const owner = new Map();
  const warnings = [];
  for (const station of stationData.stations) {
    for (const item of station.tasks) {
      if (!byName.has(item.name)) warnings.push(`路线图站点"${station.name}"里的 ${item.name} 不在任务表里`);
      if (owner.has(item.name)) warnings.push(`${item.name} 同时出现在"${owner.get(item.name)}"和"${station.name}"两个站`);
      owner.set(item.name, station.name);
    }
  }
  for (const task of report.tasks) {
    if (!owner.has(task.name)) warnings.push(`${task.name} 没有放进路线图的任何一站（scripts/plan-progress/stations.json）`);
  }

  const stations = stationData.stations.map((station, index) => {
    const tasks = station.tasks
      .filter((item) => byName.has(item.name))
      .map((item) => ({ ...item, task: byName.get(item.name) }));
    const live = tasks.filter((item) => item.task.status !== '已关闭');
    let status = 'todo';
    if (live.length > 0 && live.every((item) => item.task.status === '已完成')) status = 'done';
    else if (live.some((item) => item.task.status === '实施中' || item.task.status === '方案中')) status = 'doing';
    const waits = (station.waitingForOwner ?? [])
      .filter((wait) => byName.get(wait.task)?.status !== '已完成')
      .map((wait) => wait.text);
    const waitText = new Map((station.waitingForOwner ?? []).map((wait) => [wait.task, wait.text.replace(/^等你[：:]\s*/, '')]));
    const shortOf = tasks
      .filter((item) => item.task.status === '已完成' && item.task.reason && item.doneNote)
      .map((item) => item.doneNote);
    return {
      id: station.id,
      index,
      name: station.name,
      plain: station.plain,
      note: station.note ?? '',
      terminal: Boolean(station.terminal),
      afterLaunch: Boolean(station.afterLaunch),
      status,
      waits,
      shortOf,
      tasks: tasks.map((item) => ({
        name: item.name,
        plain: item.plain,
        word: waitText.has(item.name) && item.task.status !== '已完成' && item.task.status !== '实施中'
          ? '等你' : TASK_WORDS[item.task.status],
        waitText: waitText.get(item.name) ?? '',
        doneNote: item.task.status === '已完成' && item.task.reason && item.doneNote ? item.doneNote : '',
        fixedNote: item.note ?? '',
        status: item.task.status,
        prs: item.task.prs,
        deps: item.task.unmetDeps,
      })),
    };
  });

  // "排在 ×× 之后"：还没到的站里，任务所等的依赖属于哪些别的、还没到站的站。
  const stationOf = new Map();
  stations.forEach((station) => station.tasks.forEach((task) => stationOf.set(task.name, station)));
  for (const station of stations) {
    const after = new Map();
    if (station.status === 'todo') {
      for (const task of station.tasks) {
        for (const dep of task.deps) {
          const target = stationOf.get(dep);
          if (target && target !== station && target.status !== 'done') after.set(target.index, target.name);
        }
      }
    }
    station.after = [...after.entries()].sort((a, b) => a[0] - b[0]).map(([, name]) => name);
  }

  // 每个小任务卡片下面的一行小字：等你做什么、还差什么、排在谁之后。
  const taskOf = new Map();
  stations.forEach((station) => station.tasks.forEach((task) => taskOf.set(task.name, task)));
  for (const station of stations) {
    for (const task of station.tasks) {
      if (task.word === '等你') task.sub = `等你：${task.waitText}`;
      else if (task.doneNote) task.sub = `还差：${task.doneNote}`;
      else if (task.word === '还没开始') task.sub = task.fixedNote || afterText(task, station, stationOf, taskOf);
      else task.sub = '';
    }
  }

  const main = stations.filter((station) => !station.afterLaunch);
  const current = main.find((station) => station.status !== 'done') ?? null;
  return {
    stations,
    mainCount: main.length,
    doneCount: main.filter((station) => station.status === 'done').length,
    currentId: current?.id ?? null,
    warnings,
  };
}
