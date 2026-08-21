import { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts';

interface Summary {
  total: number;
  days: number;
  byDay: Array<{ d: string; c: number }>;
  byCountry: Array<{ country: string; c: number }>;
  byDevice: Array<{ device: string; c: number }>;
  byOs: Array<{ os: string; c: number }>;
  byBrowser: Array<{ browser: string; c: number }>;
}

interface LogEntry {
  id: number;
  event: string;
  detail: string;
  ip: string;
  country: string;
  device: string;
  os: string;
  browser: string;
  clientId: string;
  created_at: number;
}

const EVENT_LABELS: Record<string, string> = {
  visit: '访问页面',
  pairing_request: '请求验证码',
  pairing_success: '获取验证码成功',
  auth_success: '验证成功'
};

function Chart({ option, className }: { option: echarts.EChartsOption; className?: string }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    chartRef.current = chart;
    const onResize = () => chart.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, true);
  }, [option]);

  return <div ref={ref} className={className} style={{ width: '100%', height: 260 }} />;
}

const baseOption = (): echarts.EChartsOption => ({
  tooltip: { trigger: 'axis' },
  grid: { left: 40, right: 16, top: 24, bottom: 28 },
  xAxis: { type: 'category', data: [] },
  yAxis: { type: 'value', minInterval: 1 },
  series: [{ type: 'bar', data: [], itemStyle: { color: '#10b981', borderRadius: [4, 4, 0, 0] }, barMaxWidth: 36 }]
});

const pieOption = (data: Array<{ name: string; value: number }>, title: string): echarts.EChartsOption => ({
  title: { text: title, left: 'center', top: 0, textStyle: { fontSize: 13, fontWeight: 600, color: '#334155' } },
  tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
  legend: { bottom: 0, type: 'scroll', textStyle: { fontSize: 11 } },
  series: [
    {
      type: 'pie',
      radius: ['42%', '66%'],
      center: ['50%', '54%'],
      avoidLabelOverlap: true,
      itemStyle: { borderRadius: 6, borderColor: '#fff', borderWidth: 2 },
      label: { show: false },
      emphasis: { label: { show: true, fontSize: 13, fontWeight: 600 } },
      data
    }
  ]
});

export function StatsPanel(): React.JSX.Element {
  const [days, setDays] = useState(7);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [liveCount, setLiveCount] = useState(0);
  const logBoxRef = useRef<HTMLDivElement>(null);

  const loadSummary = async (d = days): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      const res = (await window.api.stats.summary(d)) as Summary;
      setSummary(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSummary();
    window.api.stats.events(200).then((rows: unknown) => {
      setLogs((rows as LogEntry[]) || []);
    }).catch(() => {});
    // 实时监控日志
    const off = window.api.on('monitor:log', (data: unknown) => {
      const entry = data as LogEntry;
      setLiveCount((n) => n + 1);
      setLogs((prev) => [entry, ...prev].slice(0, 300));
    });
    return () => off();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (logBoxRef.current) {
      logBoxRef.current.scrollTop = 0;
    }
  }, [logs]);

  const dayOption: echarts.EChartsOption = baseOption();
  const byDay = summary?.byDay || [];
  dayOption.xAxis = { type: 'category', data: byDay.map((r) => r.d) };
  (dayOption.series as echarts.SeriesOption[])[0].data = byDay.map((r) => r.c);

  const countryPie = pieOption((summary?.byCountry || []).map((r) => ({ name: r.country, value: r.c })), '地区分布');
  const devicePie = pieOption((summary?.byDevice || []).map((r) => ({ name: r.device, value: r.c })), '设备类型');
  const osPie = pieOption((summary?.byOs || []).map((r) => ({ name: r.os, value: r.c })), '操作系统');
  const browserPie = pieOption((summary?.byBrowser || []).map((r) => ({ name: r.browser, value: r.c })), '浏览器');

  const fmt = (ts: number): string => {
    const d = new Date(ts * 1000);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  const badge = (event: string): string => {
    const map: Record<string, string> = {
      visit: 'bg-sky-100 text-sky-700',
      pairing_request: 'bg-amber-100 text-amber-700',
      pairing_success: 'bg-emerald-100 text-emerald-700',
      auth_success: 'bg-emerald-100 text-emerald-700'
    };
    return map[event] || 'bg-slate-100 text-slate-600';
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-500">统计周期</span>
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => {
                setDays(d);
                loadSummary(d);
              }}
              className={`px-3 py-1 rounded-lg text-sm transition-colors ${
                days === d ? 'bg-emerald-600 text-white' : 'bg-white border border-slate-300 text-slate-600 hover:bg-slate-50'
              }`}
            >
              近{d}天
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-sm text-slate-500">实时监控中（本次会话 {liveCount} 条）</span>
        </div>
      </div>

      {error && <div className="text-red-600 text-sm">加载失败：{error}</div>}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <p className="text-sm text-slate-500">总访问量（近{days}天）</p>
          <p className="text-2xl font-bold text-slate-900 mt-1">{loading ? '…' : summary?.total ?? 0}</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <p className="text-sm text-slate-500">地区数</p>
          <p className="text-2xl font-bold text-slate-900 mt-1">{summary?.byCountry.length ?? 0}</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <p className="text-sm text-slate-500">反馈数</p>
          <p className="text-2xl font-bold text-slate-900 mt-1">{summary?.byBrowser.length ?? 0}</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <p className="text-sm text-slate-500">今日新增（近1天）</p>
          <p className="text-2xl font-bold text-slate-900 mt-1">
            {summary?.byDay.length ? summary.byDay[summary.byDay.length - 1].c : 0}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <h3 className="text-sm font-semibold text-slate-700 mb-2">访问趋势（访问数据统计）</h3>
          {loading ? <div className="text-sm text-slate-400 py-10 text-center">加载中…</div> : <Chart option={dayOption} />}
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <h3 className="text-sm font-semibold text-slate-700 mb-2">地区统计</h3>
          {loading ? <div className="text-sm text-slate-400 py-10 text-center">加载中…</div> : <Chart option={countryPie} />}
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <h3 className="text-sm font-semibold text-slate-700 mb-2">设备类型</h3>
          {loading ? <div className="text-sm text-slate-400 py-10 text-center">加载中…</div> : <Chart option={devicePie} />}
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <h3 className="text-sm font-semibold text-slate-700 mb-2">环境统计（操作系统）</h3>
          {loading ? <div className="text-sm text-slate-400 py-10 text-center">加载中…</div> : <Chart option={osPie} />}
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4 lg:col-span-2">
          <h3 className="text-sm font-semibold text-slate-700 mb-2">环境统计（浏览器）</h3>
          {loading ? <div className="text-sm text-slate-400 py-10 text-center">加载中…</div> : <Chart option={browserPie} />}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <h3 className="text-sm font-semibold text-slate-700 mb-3">实时监控日志（WebSocket）</h3>
        <div ref={logBoxRef} className="max-h-80 overflow-y-auto space-y-1.5 pr-1">
          {logs.length === 0 && <p className="text-sm text-slate-400 text-center py-6">暂无日志</p>}
          {logs.map((log) => (
            <div key={`${log.id}-${log.created_at}`} className="flex items-center gap-2 text-sm px-3 py-2 rounded-lg bg-slate-50 border border-slate-100">
              <span className={`shrink-0 px-2 py-0.5 rounded-full text-xs font-medium ${badge(log.event)}`}>
                {EVENT_LABELS[log.event] || log.event}
              </span>
              <span className="shrink-0 text-slate-400 font-mono text-xs">{fmt(log.created_at)}</span>
              <span className="shrink-0 text-slate-600">{log.country || '未知'}</span>
              <span className="shrink-0 text-slate-500 text-xs">{log.ip || '-'}</span>
              <span className="shrink-0 text-slate-500 text-xs">{log.device}/{log.os}</span>
              <span className="shrink-0 text-slate-500 text-xs">{log.browser}</span>
              {log.detail && <span className="text-slate-500 text-xs truncate ml-auto">{log.detail}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}