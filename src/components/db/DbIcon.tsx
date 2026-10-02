import { siClickhouse, siGooglebigquery, siMariadb, siMongodb, siMysql, siPostgresql, siRedis } from "simple-icons";
import { Database } from "lucide-react";

// Logo từng loại database (Simple Icons, CC0) với màu thương hiệu, chỉnh sáng hơn
// chỗ màu gốc quá tối trên nền tối: MariaDB (#003545 → nâu con hải cẩu), MySQL và
// PostgreSQL (xanh đậm → xanh trung tính, đọc được ở cả theme sáng lẫn tối).
const ICONS: Record<string, { path: string; color: string; title: string }> = {
  mysql: { path: siMysql.path, color: "#5B9BD5", title: "MySQL" },
  mariadb: { path: siMariadb.path, color: "#C0765A", title: "MariaDB" },
  postgres: { path: siPostgresql.path, color: "#6A8FEF", title: "PostgreSQL" },
  clickhouse: { path: siClickhouse.path, color: "#E5B800", title: "ClickHouse" },
  redis: { path: siRedis.path, color: `#${siRedis.hex}`, title: "Redis" },
  mongodb: { path: siMongodb.path, color: `#${siMongodb.hex}`, title: "MongoDB" },
  bigquery: { path: siGooglebigquery.path, color: `#${siGooglebigquery.hex}`, title: "BigQuery" },
};

/** Màu thương hiệu của loại DB (dùng cho nền icon, viền…). */
export function dbColor(kind: string): string {
  return ICONS[kind]?.color ?? "var(--primary)";
}

/** Logo của loại database; loại chưa có logo → icon database chung. */
export function DbIcon({ kind, className }: { kind: string; className?: string }) {
  const icon = ICONS[kind];
  if (!icon) return <Database className={className} />;
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill={icon.color}
      role="img"
      aria-label={icon.title}
      // Logo MySQL là nét mảnh kèm chữ → phóng to chút cho cân với các logo khác.
      style={kind === "mysql" ? { transform: "scale(1.25)" } : undefined}
    >
      <path d={icon.path} />
    </svg>
  );
}
