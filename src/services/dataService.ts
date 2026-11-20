import { supabase } from './supabaseClient';
import { authService } from './authService';
import {
  Agent,
  Cargo,
  Puesto,
  Horario,
  LicenseType,
  LicenseRequest,
  SisoLicense,
  SisoImportHistory,
  AuditLog,
  WeeklyAbsenceRow,
  LongLicenseItem,
  LicenseStatus,
  HistorialEstadoSolicitud,
  PuestoCargo,
} from '../types';

const LEGACY_STORAGE_KEYS = [
  'cpem_agents_v7',
  'cpem_cargos_v6',
  'cpem_puestos_v7',
  'cpem_puestos_cargos_v7',
  'cpem_license_types_v6',
  'cpem_license_requests_v6',
  'cpem_siso_licenses_v7',
  'cpem_siso_imports_v7',
  'cpem_audit_logs_v6',
];

const TURNO_CODE_TO_LABEL: Record<string, Cargo['turno']> = {
  M: 'Mañana',
  TM: 'Mañana',
  T: 'Tarde',
  TT: 'Tarde',
  V: 'Vespertino',
  TV: 'Vespertino',
  C: 'Central',
  TC: 'Central',
  E: 'Extendido',
  TE: 'Extendido',
  I: 'Intermedio',
  TI: 'Intermedio',
  N: 'Noche',
  TN: 'Noche',
};

function turnoLabelToCode(turno?: string, explicitCode?: string): string {
  if (explicitCode && explicitCode.trim()) return explicitCode.trim().slice(0, 2).toUpperCase();
  const t = (turno || '').toLowerCase();
  if (t.includes('tard')) return 'T';
  if (t.includes('vesp')) return 'V';
  if (t.includes('cent')) return 'TC';
  if (t.includes('ext')) return 'TE';
  if (t.includes('inter')) return 'TI';
  if (t.includes('noch')) return 'N';
  return 'M';
}

function mapTurnoCode(code?: string): Cargo['turno'] {
  const clean = (code || '').trim().toUpperCase();
  return TURNO_CODE_TO_LABEL[clean] || 'Mañana';
}

function formatCursoDisplay(raw?: string | null): string {
  const val = (raw || '').trim();
  if (!val) return '';
  return val.includes('°') ? val : `${val}°`;
}

function formatSeccionDisplay(raw?: string | null): string {
  const val = (raw || '').trim();
  if (!val) return '';
  return /^div\./i.test(val) ? val : `Div. ${val}`;
}

/**
 * Normaliza fechas provenientes de SISO (DD-MM-YYYY o DD/MM/YYYY) a formato estándar ISO YYYY-MM-DD.
 */
export function normalizeSisoDate(dateStr: string): string {
  if (!dateStr) return '';
  const trimmed = dateStr.trim();
  const dmyMatch = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmyMatch) {
    const day = dmyMatch[1].padStart(2, '0');
    const month = dmyMatch[2].padStart(2, '0');
    const year = dmyMatch[3];
    return `${year}-${month}-${day}`;
  }
  const ymdMatch = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (ymdMatch) {
    const year = ymdMatch[1];
    const month = ymdMatch[2].padStart(2, '0');
    const day = ymdMatch[3].padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return trimmed;
}

/**
 * Limpia y normaliza el nombre de un encabezado CSV para comparación robusta
 */
export function cleanHeaderKey(h: string): string {
  return h
    .trim()
    .replace(/^["']|["']$/g, '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[._\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const STANDARD_SISO_HEADERS: string[] = [
  'ID',
  'NRO EMPLEADO',
  'DNI',
  'NOMBRE',
  'EMAIL',
  'TIPO',
  'CARGA',
  'DESDE',
  'HASTA',
  'DIAS',
  'JUSTIFICA',
  'COD LICENCIA',
  'FECHA ALTA',
  'AUDITOR',
  'PATOLOGIA',
  'FECHA AUDITORIA',
  'MEDICO_INTERVINIENTE',
  'MATRICULA_MEDICO_INTERVINIENTE',
  'ESTABLECIMIENTOS O SECTOR',
];

export interface PreprocessedSisoResult {
  headers: string[];
  dataRows: string[];
  delimiter: string;
  isHeaderAutoAssigned: boolean;
}

export function preprocessSisoCsv(rawText: string): PreprocessedSisoResult {
  const rawLines = rawText.split(/\r?\n/);
  const cleanLines: string[] = [];

  for (const l of rawLines) {
    let line = l.trim();
    if (!line) continue;
    if (/^[-*•]?\s*encabezados\s*:\s*/i.test(line)) {
      line = line.replace(/^[-*•]?\s*encabezados\s*:\s*/i, '').trim();
    }
    if (/^[-*•]?\s*ejemplos?\s*:\s*$/i.test(line) || /^[-*•]?\s*notas?\s*:\s*$/i.test(line)) {
      continue;
    }
    if (line.startsWith('#') || line.startsWith('//')) continue;

    cleanLines.push(line);
  }

  if (cleanLines.length === 0) {
    return {
      headers: [],
      dataRows: [],
      delimiter: ';',
      isHeaderAutoAssigned: false,
    };
  }

  const firstWithSep = cleanLines.find((l) => l.includes(';') || l.includes(',')) || cleanLines[0];
  const semiCount = (firstWithSep.match(/;/g) || []).length;
  const commaCount = (firstWithSep.match(/,/g) || []).length;
  const delimiter = semiCount >= commaCount ? ';' : ',';

  const firstLineTokens = parseCSVLine(cleanLines[0], delimiter);
  const firstLineUpper = cleanLines[0].toUpperCase();

  const isHeaderRow =
    firstLineUpper.includes('ID') ||
    firstLineUpper.includes('EMPLEADO') ||
    firstLineUpper.includes('LEGAJO') ||
    firstLineUpper.includes('NOMBRE') ||
    firstLineUpper.includes('DESDE');

  let headers: string[] = [];
  let dataRows: string[] = [];
  let isHeaderAutoAssigned = false;

  if (isHeaderRow) {
    headers = firstLineTokens.map(cleanHeaderKey);
    dataRows = cleanLines.slice(1);
  } else {
    headers = STANDARD_SISO_HEADERS.map(cleanHeaderKey);
    dataRows = cleanLines;
    isHeaderAutoAssigned = true;
  }

  return { headers, dataRows, delimiter, isHeaderAutoAssigned };
}

export function getField(row: Record<string, string>, ...keys: string[]): string {
  for (const k of keys) {
    const cleanK = cleanHeaderKey(k);
    if (row[cleanK] !== undefined && row[cleanK] !== '') {
      return row[cleanK].trim();
    }
  }
  return '';
}

export function parseCSVLine(line: string, delimiter?: string): string[] {
  if (!delimiter) {
    const semiCount = (line.match(/;/g) || []).length;
    const commaCount = (line.match(/,/g) || []).length;
    delimiter = semiCount >= commaCount ? ';' : ',';
  }

  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      result.push(current.trim().replace(/^["']|["']$/g, ''));
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim().replace(/^["']|["']$/g, ''));
  return result;
}

export function calculateDaysBetween(from: string, to: string): number {
  if (!from || !to) return 0;
  const normFrom = normalizeSisoDate(from);
  const normTo = normalizeSisoDate(to);
  const d1 = new Date(normFrom + 'T00:00:00');
  const d2 = new Date(normTo + 'T00:00:00');
  if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return 0;
  const diffTime = d2.getTime() - d1.getTime();
  if (diffTime < 0) return 0;
  return Math.round(diffTime / (1000 * 60 * 60 * 24)) + 1;
}

export function getMonday(d: Date): Date {
  const date = new Date(d);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  date.setDate(diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

export function formatYMD(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatDM(d: Date): string {
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${day}-${month}`;
}

export function formatDMY(dateInput?: string | Date | null): string {
  if (!dateInput) return '';

  if (dateInput instanceof Date) {
    if (isNaN(dateInput.getTime())) return '';
    const day = String(dateInput.getDate()).padStart(2, '0');
    const month = String(dateInput.getMonth() + 1).padStart(2, '0');
    const year = String(dateInput.getFullYear()).slice(-2);
    return `${day}-${month}-${year}`;
  }

  const str = String(dateInput).trim();
  if (!str) return '';

  const cleanStr = str.split('T')[0].trim();

  const ymdMatch = cleanStr.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (ymdMatch) {
    const year = ymdMatch[1].slice(-2);
    const month = ymdMatch[2].padStart(2, '0');
    const day = ymdMatch[3].padStart(2, '0');
    return `${day}-${month}-${year}`;
  }

  const dmy4Match = cleanStr.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmy4Match) {
    const day = dmy4Match[1].padStart(2, '0');
    const month = dmy4Match[2].padStart(2, '0');
    const year = dmy4Match[3].slice(-2);
    return `${day}-${month}-${year}`;
  }

  const dmy2Match = cleanStr.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2})$/);
  if (dmy2Match) {
    const day = dmy2Match[1].padStart(2, '0');
    const month = dmy2Match[2].padStart(2, '0');
    const year = dmy2Match[3];
    return `${day}-${month}-${year}`;
  }

  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    const day = String(parsed.getDate()).padStart(2, '0');
    const month = String(parsed.getMonth() + 1).padStart(2, '0');
    const year = String(parsed.getFullYear()).slice(-2);
    return `${day}-${month}-${year}`;
  }

  return str;
}

export function formatDateTimeDMY(dateInput?: string | Date | null): string {
  if (!dateInput) return '';
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (isNaN(d.getTime())) return formatDMY(dateInput);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = String(d.getFullYear()).slice(-2);
  const hours = String(d.getHours()).padStart(2, '0');
  const mins = String(d.getMinutes()).padStart(2, '0');
  return `${day}-${month}-${year} ${hours}:${mins} hs`;
}

class DataService {
  private agents: Agent[] = [];
  private cargos: Cargo[] = [];
  private puestos: Puesto[] = [];
  private puestosCargos: PuestoCargo[] = [];
  private licenseTypes: LicenseType[] = [];
  private requests: LicenseRequest[] = [];
  private sisoLicenses: SisoLicense[] = [];
  private sisoImports: SisoImportHistory[] = [];
  private auditLogs: AuditLog[] = [];
  private initialized = false;
  private isLoaded = false;
  private loadPromise: Promise<void> | null = null;
  private realtimeSetup = false;
  private refreshDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners: Array<() => void> = [];

  constructor() {
    this.purgeLegacyCache();
  }

  private purgeLegacyCache() {
    if (typeof localStorage === 'undefined') return;
    try {
      for (const key of LEGACY_STORAGE_KEYS) {
        localStorage.removeItem(key);
      }
    } catch {
      // Ignore storage access restrictions
    }
  }

  public subscribe(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  public notifyListeners() {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (e) {
        console.error('Error in dataService listener:', e);
      }
    }
  }

  public getIsLoaded(): boolean {
    return this.isLoaded;
  }

  private async fetchAllRows<T = any>(
    table: string,
    orderCol: string,
    ascending = true,
    secondaryOrderCol?: string
  ): Promise<{ data: T[] | null; error: any }> {
    const pageSize = 1000;
    let from = 0;
    const allRows: T[] = [];

    while (true) {
      let query = supabase.from(table).select('*').order(orderCol, { ascending });
      if (secondaryOrderCol) {
        query = query.order(secondaryOrderCol, { ascending: true });
      }
      const { data, error } = await query.range(from, from + pageSize - 1);
      if (error) {
        return { data: null, error };
      }
      if (!data || data.length === 0) {
        break;
      }
      allRows.push(...(data as T[]));
      if (data.length < pageSize) {
        break;
      }
      from += pageSize;
    }

    return { data: allRows, error: null };
  }

  private isPrimaryKeyViolation(error: any, table: string): boolean {
    if (!error) return false;
    const msg = `${error.message || ''} ${error.details || ''}`.toLowerCase();
    return error.code === '23505' && (msg.includes(`${table}_pkey`) || msg.includes('_pkey'));
  }

  private async insertWithIdentityFallback<T = any>(
    table: string,
    pkColumn: string,
    payload: Record<string, any>
  ): Promise<{ data: T | null; error: any }> {
    const firstAttempt = await supabase.from(table).insert(payload).select().single();
    if (!firstAttempt.error) {
      return { data: firstAttempt.data as T, error: null };
    }

    if (!this.isPrimaryKeyViolation(firstAttempt.error, table)) {
      return { data: null, error: firstAttempt.error };
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      const { data: maxRows, error: maxErr } = await supabase
        .from(table)
        .select(pkColumn)
        .order(pkColumn, { ascending: false })
        .limit(1);

      if (maxErr) {
        return { data: null, error: maxErr };
      }

      const currentMax = maxRows && maxRows.length > 0 ? Number((maxRows[0] as any)[pkColumn]) || 0 : 0;
      const nextId = currentMax + 1 + attempt;

      const retry = await supabase
        .from(table)
        .insert({ ...payload, [pkColumn]: nextId })
        .select()
        .single();

      if (!retry.error) {
        return { data: retry.data as T, error: null };
      }

      if (!this.isPrimaryKeyViolation(retry.error, table)) {
        return { data: null, error: retry.error };
      }
    }

    return { data: null, error: firstAttempt.error };
  }

  private async insertManyWithIdentityFallback<T = any>(
    table: string,
    pkColumn: string,
    rows: Record<string, any>[]
  ): Promise<{ data: T[] | null; error: any }> {
    if (rows.length === 0) return { data: [], error: null };

    const firstAttempt = await supabase.from(table).insert(rows).select();
    if (!firstAttempt.error) {
      return { data: (firstAttempt.data || []) as T[], error: null };
    }

    if (!this.isPrimaryKeyViolation(firstAttempt.error, table)) {
      return { data: null, error: firstAttempt.error };
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const { data: maxRows, error: maxErr } = await supabase
        .from(table)
        .select(pkColumn)
        .order(pkColumn, { ascending: false })
        .limit(1);

      if (maxErr) {
        return { data: null, error: maxErr };
      }

      const currentMax = maxRows && maxRows.length > 0 ? Number((maxRows[0] as any)[pkColumn]) || 0 : 0;
      const startId = currentMax + 1 + attempt * rows.length;
      const rowsWithIds = rows.map((r, idx) => ({ ...r, [pkColumn]: startId + idx }));

      const retry = await supabase.from(table).insert(rowsWithIds).select();
      if (!retry.error) {
        return { data: (retry.data || []) as T[], error: null };
      }

      if (!this.isPrimaryKeyViolation(retry.error, table)) {
        return { data: null, error: retry.error };
      }
    }

    return { data: null, error: firstAttempt.error };
  }

  public async initialize(force = false): Promise<void> {
    if (this.initialized && !force) return;
    if (this.loadPromise && !force) return this.loadPromise;

    this.loadPromise = (async () => {
      this.initialized = true;
      await this.refreshFromSupabase();
      this.setupRealtimeSubscriptions();
      // Cargar SISO en segundo plano sin bloquear el arranque inicial
      this.refreshSisoFromSupabase().catch((err) => {
        console.warn('Error cargando SISO en segundo plano:', err);
      });
    })();

    return this.loadPromise;
  }

  private mapDbAgent(a: any): Agent {
    return {
      id: `ag-${a.agente_id}`,
      agente_id: a.agente_id,
      apellidos: a.apellido || '',
      apellido: a.apellido || '',
      nombres: a.nombre || '',
      nombre: a.nombre || '',
      fullName: `${a.apellido || ''}, ${a.nombre || ''}`.trim(),
      employeeNumber: String(a.legajo || ''),
      legajo: a.legajo,
      dni: String(a.dni || ''),
      telefono: a.telefono || '',
      email: a.email || '',
      fechaNacimiento: a.fecha_nac || '',
      fecha_nac: a.fecha_nac || '',
      lugarNacimiento: a.lugar_nacimiento || '',
      lugar_nacimiento: a.lugar_nacimiento || '',
      domicilio: a.domicilio || '',
      titulo: a.titulo || '',
      activo: a.activo !== false,
      hasAssignedPost: false,
      createdAt: a.created_at || new Date().toISOString(),
    };
  }

  private mapDbCargo(c: any, horariosByCargoId: Map<number, any[]>): Cargo {
    const cargoHorariosList = horariosByCargoId.get(Number(c.cargo_id)) || [];
    const regularHorarios = cargoHorariosList
      .filter((h) => !h.articulacion)
      .map((h) => ({
        id: `horario-${h.horario_id}`,
        horario_id: h.horario_id,
        cargo_id: h.cargo_id,
        dia: h.dia,
        horaIngreso: (h.hora_desde || '').slice(0, 5),
        horaSalida: (h.hora_hasta || '').slice(0, 5),
        articulacion: false,
      }));

    const artHorarios = cargoHorariosList.filter((h) => h.articulacion);
    const primerHorarioArt =
      artHorarios.length > 0
        ? {
            id: `horario-${artHorarios[0].horario_id}`,
            horario_id: artHorarios[0].horario_id,
            cargo_id: artHorarios[0].cargo_id,
            dia: artHorarios[0].dia,
            horaIngreso: (artHorarios[0].hora_desde || '').slice(0, 5),
            horaSalida: (artHorarios[0].hora_hasta || '').slice(0, 5),
            articulacion: true,
          }
        : undefined;

    const horariosArticulacionList = artHorarios.map((h) => ({
      id: `horario-${h.horario_id}`,
      horario_id: h.horario_id,
      cargo_id: h.cargo_id,
      dia: h.dia,
      horaIngreso: (h.hora_desde || '').slice(0, 5),
      horaSalida: (h.hora_hasta || '').slice(0, 5),
      articulacion: true,
    }));

    return {
      id: `cargo-${c.cargo_id}`,
      cargo_id: c.cargo_id,
      secuencia: String(c.secuencia ?? ''),
      turno: mapTurnoCode(c.turno),
      turno_codigo: c.turno,
      curso: formatCursoDisplay(c.curso),
      curso_raw: c.curso || '',
      seccion: formatSeccionDisplay(c.seccion),
      seccion_raw: c.seccion || '',
      descripcion: c.descripccion || '',
      obligaciones: String(c.obligaciones || 1),
      area: '',
      area_id: c.area_id ?? null,
      horarios: regularHorarios,
      tieneArticulacion: Boolean(c.tiene_art) || artHorarios.length > 0,
      tiene_art: Boolean(c.tiene_art) || artHorarios.length > 0,
      horarioArticulacion: primerHorarioArt,
      horariosArticulacion: horariosArticulacionList,
      activo: c.activo !== false,
      ordenVisual: c.orden_visual ?? c.cargo_id ?? 1,
      orden_visual: c.orden_visual ?? c.cargo_id ?? 1,
      createdAt: c.created_at || new Date().toISOString(),
    };
  }

  private mapDbLicenseType(t: any): LicenseType {
    return {
      id: `type-${t.tipo_licencia_id}`,
      tipo_licencia_id: t.tipo_licencia_id,
      code: t.codigo || '',
      codigo: t.codigo || '',
      name: t.nombre || '',
      nombre: t.nombre || '',
      category: (t.categoria as any) || 'Corta duración',
      categoria: t.categoria || 'Corta duración',
      sinLimite: Boolean(t.sin_limite),
      sin_limite: Boolean(t.sin_limite),
      maxDaysPerYear: t.max_dias_anio,
      max_dias_anio: t.max_dias_anio,
      diasTotales: t.max_dias_anio,
      maxConsecutiveDays: t.max_dias_seguidos,
      max_dias_seguidos: t.max_dias_seguidos,
      diasMensuales: t.max_dias_seguidos,
      requiresJustification: Boolean(t.requiere_justificacion),
      requiere_justificacion: Boolean(t.requiere_justificacion),
      requiresObligations: t.requiere_obligaciones !== false,
      requiere_obligaciones: t.requiere_obligaciones !== false,
      description: t.descripccion || '',
      descripccion: t.descripccion || '',
      active: t.activo !== false,
      activo: t.activo !== false,
    };
  }

  public async refreshFromSupabase(): Promise<void> {
    try {
      const [
        agentesRes,
        cargosRes,
        horariosRes,
        puestosRes,
        puestosCargosRes,
        typesRes,
      ] = await Promise.all([
        this.fetchAllRows('agentes', 'agente_id', true),
        this.fetchAllRows('cargos', 'orden_visual', true, 'cargo_id'),
        this.fetchAllRows('horarios_cargos', 'horario_id', true),
        this.fetchAllRows('puestos', 'puesto_id', true),
        this.fetchAllRows('puestos_cargos', 'orden', true, 'puestos_cargos_id'),
        this.fetchAllRows('tipos_licencias', 'tipo_licencia_id', true),
      ]);

      // 1. Agentes
      if (agentesRes.error) {
        console.error('Error fetching agentes from Supabase:', agentesRes.error.message);
      } else if (agentesRes.data) {
        this.agents = agentesRes.data.map((a) => this.mapDbAgent(a));
      }

      // 2. Horarios + Cargos (solo activos)
      const horariosByCargoId = new Map<number, any[]>();
      if (horariosRes.error) {
        console.error('Error fetching horarios_cargos from Supabase:', horariosRes.error.message);
      } else if (horariosRes.data) {
        for (const h of horariosRes.data) {
          const cid = Number(h.cargo_id);
          if (!horariosByCargoId.has(cid)) {
            horariosByCargoId.set(cid, []);
          }
          horariosByCargoId.get(cid)!.push(h);
        }
      }

      if (cargosRes.error) {
        console.error('Error fetching cargos from Supabase:', cargosRes.error.message);
      } else if (cargosRes.data) {
        this.cargos = cargosRes.data
          .filter((c: any) => c.activo !== false)
          .map((c: any) => this.mapDbCargo(c, horariosByCargoId));
      }

      // 3. Puestos (solo activos)
      if (puestosRes.error) {
        console.error('Error fetching puestos from Supabase:', puestosRes.error.message);
      } else if (puestosRes.data) {
        this.puestos = puestosRes.data
          .filter((p: any) => p.activo !== false)
          .map((p: any) => ({
            id: `puesto-${p.puesto_id}`,
            puesto_id: p.puesto_id,
            cargoId: `cargo-${p.cargo_id}`,
            cargo_id: p.cargo_id,
            agentesAsignados: [],
            activo: p.activo !== false,
            createdAt: p.created_at || new Date().toISOString(),
          }));
      }

      // 4. Puestos Cargos (asignaciones)
      if (puestosCargosRes.error) {
        console.error('Error fetching puestos_cargos from Supabase:', puestosCargosRes.error.message);
      } else if (puestosCargosRes.data) {
        this.puestosCargos = puestosCargosRes.data.map((pc: any) => ({
          puestos_cargos_id: pc.puestos_cargos_id,
          puesto_id: pc.puesto_id,
          agente_id: pc.agente_id,
          orden: pc.orden || 1,
          sit_revista: pc.sit_revista || 'Interino',
          fecha_alta: pc.fecha_alta,
          activo: pc.activo !== false,
          detalle: pc.detalle,
        }));

        for (const p of this.puestos) {
          const asigs = this.puestosCargos
            .filter((pc) => pc.puesto_id === p.puesto_id && pc.activo !== false)
            .sort((a, b) => (a.orden || 1) - (b.orden || 1));

          p.agentesAsignados = asigs.map((asig) => ({
            agenteId: `ag-${asig.agente_id}`,
            orden: asig.orden,
            fechaAsignacion: asig.fecha_alta || '2026-02-01',
            situacionRevista: (asig.sit_revista as any) || 'Interino',
            observacion: asig.detalle || undefined,
          }));
        }
      }

      // 5. Tipos de Licencias
      if (typesRes.error) {
        console.error('Error fetching tipos_licencias from Supabase:', typesRes.error.message);
      } else if (typesRes.data) {
        this.licenseTypes = typesRes.data.map((t: any) => this.mapDbLicenseType(t));
      }

      // 6. Solicitudes de Licencias
      await this.refreshRequestsFromSupabase(false);

      this.isLoaded = true;
      this.notifyListeners();
    } catch (err) {
      console.error('Error refreshing from Supabase:', err);
    }
  }

  public async refreshSisoFromSupabase(): Promise<void> {
    try {
      const { data: dbSiso, error } = await this.fetchAllRows('siso_licencias', 'siso_id', false);
      if (error) {
        console.warn('Error fetching siso_licencias from Supabase:', error.message);
        return;
      }
      if (dbSiso) {
        this.sisoLicenses = dbSiso.map((s: any): SisoLicense => ({
          id: s.id,
          siso_id: s.siso_id,
          nro_empleado: s.nro_empleado,
          nroEmpleado: s.nro_empleado || '',
          dni: s.dni || '',
          nombre: s.nombre || '',
          email: s.email || '',
          tipo: s.tipo || '',
          carga: s.carga || '',
          fecha_desde: s.fecha_desde,
          fecha_hasta: s.fecha_hasta,
          desde: s.fecha_desde || '',
          hasta: s.fecha_hasta || '',
          dias: s.dias || '',
          justifica: s.justifica || '',
          cod_licencia: s.cod_licencia ? String(s.cod_licencia) : '',
          codLicencia: s.cod_licencia ? String(s.cod_licencia) : '',
          fecha_alta: s.fecha_alta,
          fechaAlta: s.fecha_alta,
          auditor: s.auditor,
          patologia: s.patologia,
          fecha_auditoria: s.fecha_auditoria,
          fechaAuditoria: s.fecha_auditoria,
          medico_interviniente: s.medico_interviniente,
          medicoInterviniente: s.medico_interviniente,
          matricula_medico_interviniente: s.matricula_medico_interviniente,
          matriculaMedicoInterviniente: s.matricula_medico_interviniente,
          establecimientos_o_sector: s.establecimientos_o_sector,
          establecimientosOSector: s.establecimientos_o_sector,
          fechaImportacion: s.created_at || new Date().toISOString(),
          importId: 'import-supabase',
        }));
        this.notifyListeners();
      }
    } catch (e) {
      console.warn('Error refreshing SISO from Supabase:', e);
    }
  }

  private scheduleRefreshFromSupabase() {
    if (this.refreshDebounceTimer) {
      clearTimeout(this.refreshDebounceTimer);
    }
    this.refreshDebounceTimer = setTimeout(() => {
      this.refreshFromSupabase();
    }, 250);
  }

  private setupRealtimeSubscriptions() {
    if (this.realtimeSetup) return;
    this.realtimeSetup = true;
    try {
      supabase
        .channel('cpem25_realtime_sync')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'solicitud_licencias' }, () => {
          this.refreshRequestsFromSupabase(true);
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'cargos' }, () => {
          this.scheduleRefreshFromSupabase();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'horarios_cargos' }, () => {
          this.scheduleRefreshFromSupabase();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'puestos' }, () => {
          this.scheduleRefreshFromSupabase();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'puestos_cargos' }, () => {
          this.scheduleRefreshFromSupabase();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'agentes' }, () => {
          this.scheduleRefreshFromSupabase();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'tipos_licencias' }, () => {
          this.scheduleRefreshFromSupabase();
        })
        .subscribe();
    } catch (e) {
      console.warn('Realtime subscription notice:', e);
    }
  }

  public async refreshRequestsFromSupabase(notify = true) {
    try {
      const { data: dbReqs, error } = await this.fetchAllRows(
        'solicitud_licencias',
        'solicitud_licencia_id',
        false
      );

      if (error) {
        console.error('Error refreshing requests from Supabase:', error.message);
        return;
      }

      if (dbReqs) {
        const extractDriveId = (url?: string | null): string | undefined => {
          if (!url || !url.includes('drive.google.com')) return undefined;
          const m = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
          return m?.[1];
        };

        this.requests = dbReqs.map((row: any): LicenseRequest => {
          const agent = this.agents.find((a) => a.agente_id === row.agente_id);
          const type = this.licenseTypes.find((t) => t.tipo_licencia_id === row.tipo_licencia_id);
          const sigUrl: string = row.signature_data_url || '';
          const justUrl: string | undefined = row.justificacion_url || undefined;
          const sigDriveId = extractDriveId(sigUrl);
          const justDriveId = extractDriveId(justUrl);

          const rawPosts = Array.isArray(row.puestos_id) ? row.puestos_id : [];
          let postDescription = 'Cargos asignados';
          if (rawPosts.length > 0 && rawPosts[0] !== 'ALL') {
            const descs = rawPosts
              .map((pid: string) => {
                const p = this.puestos.find(
                  (pu) => pu.id === pid || String(pu.puesto_id) === String(pid)
                );
                const c = p ? this.cargos.find((cg) => cg.id === p.cargoId) : null;
                return c ? `${c.descripcion} (${c.curso} ${c.seccion})`.trim() : null;
              })
              .filter(Boolean);
            if (descs.length > 0) {
              postDescription = descs.join(' / ');
            }
          }

          return {
            id: row.codigo || `SOL-2026-${String(row.solicitud_licencia_id).padStart(3, '0')}`,
            employeeNumber: String(agent?.legajo || agent?.employeeNumber || ''),
            agentName: agent?.fullName || `Agente #${row.agente_id}`,
            agentDni: String(agent?.dni || ''),
            postsSelection: rawPosts.length > 0 ? rawPosts.join(', ') : 'ALL',
            postDescription,
            dateFrom: row.fecha_desde,
            dateTo: row.fecha_hasta,
            isArticulation: row.articulacion || false,
            licenseTypeId: `type-${row.tipo_licencia_id}`,
            licenseTypeCode: type?.code || '',
            licenseTypeName: type?.name || '',
            note: row.detalle_solicitud || undefined,
            detail: row.detalle_solicitud || undefined,
            cantidadObligaciones: row.obligaciones || 1,
            justificationDataUrl: justUrl,
            justificationDriveUrl: justUrl && justUrl.includes('drive.google.com') ? justUrl : undefined,
            justificationDriveFileId: justDriveId,
            signatureDataUrl: sigUrl,
            signatureDriveUrl: sigUrl && sigUrl.includes('drive.google.com') ? sigUrl : undefined,
            signatureDriveFileId: sigDriveId,
            status: (row.estado as LicenseStatus) || 'Pendiente',
            createdAt: row.created_at || row.fecha_carga || new Date().toISOString(),
            deletedAt: row.deleted_at || undefined,
            source: 'Solicitud',
            historialEstados: [],
          };
        });

        if (notify) {
          this.notifyListeners();
        }
      }
    } catch (e) {
      console.warn('Error refreshing requests from Supabase:', e);
    }
  }

  // AGENTES CRUD
  public getAgents(): Agent[] {
    return this.agents.map((ag) => {
      const assignedPuestos = this.puestos.filter((p) =>
        p.agentesAsignados.some(
          (asig) =>
            asig.agenteId === ag.id ||
            (ag.agente_id && asig.agenteId === `ag-${ag.agente_id}`) ||
            (ag.agente_id && asig.agenteId === String(ag.agente_id))
        )
      );
      return {
        ...ag,
        hasAssignedPost: assignedPuestos.length > 0,
        posts: assignedPuestos.map((p) => {
          const c = this.cargos.find((cargo) => cargo.id === p.cargoId);
          return {
            id: p.id,
            cargo: c?.descripcion || 'Cargo',
            curso: `${c?.curso || ''} ${c?.seccion || ''} (${c?.turno || ''})`.trim(),
            situacionRevista:
              p.agentesAsignados.find(
                (as) =>
                  as.agenteId === ag.id ||
                  (ag.agente_id && as.agenteId === `ag-${ag.agente_id}`) ||
                  (ag.agente_id && as.agenteId === String(ag.agente_id))
              )?.situacionRevista || 'Titular',
            assigned: true,
          };
        }),
      };
    });
  }

  public getAgentById(id: string): Agent | null {
    const list = this.getAgents();
    return list.find((a) => a.id === id) || null;
  }

  public async verifyAgent(employeeNumber: string): Promise<Agent | null> {
    await this.initialize();
    const trimmed = employeeNumber.trim().toLowerCase();
    if (!trimmed) return null;

    const list = this.getAgents();
    const found = list.find(
      (a) =>
        a.employeeNumber.toLowerCase() === trimmed ||
        a.dni.toLowerCase() === trimmed ||
        a.dni.replace(/\D/g, '') === trimmed.replace(/\D/g, '') ||
        a.employeeNumber.replace(/\D/g, '') === trimmed.replace(/\D/g, '')
    );
    if (found) return found;

    try {
      const numVal = parseInt(trimmed.replace(/\D/g, ''), 10);
      let q = supabase.from('agentes').select('*');
      if (!isNaN(numVal) && numVal > 0) {
        q = q.or(`dni.eq.${numVal},legajo.eq.${numVal}`);
      } else {
        q = q.ilike('apellido', `%${trimmed}%`);
      }
      const { data: dbAgs } = await q.limit(1);
      if (dbAgs && dbAgs.length > 0) {
        await this.refreshFromSupabase();
        return this.getAgents().find((a) => a.agente_id === dbAgs[0].agente_id) || null;
      }
    } catch (err) {
      console.warn('Error querying agente directly from Supabase:', err);
    }
    return null;
  }

  public async createAgent(data: Omit<Agent, 'id' | 'fullName' | 'hasAssignedPost'>): Promise<Agent> {
    const existsNum = this.agents.some((a) => a.employeeNumber === data.employeeNumber.trim());
    if (existsNum) {
      throw new Error(`Ya existe un agente registrado con el número de empleado ${data.employeeNumber}.`);
    }
    const existsDni = this.agents.some((a) => a.dni.replace(/\D/g, '') === data.dni.replace(/\D/g, ''));
    if (existsDni) {
      throw new Error(`Ya existe un agente registrado con el DNI ${data.dni}.`);
    }

    const dniNum = parseInt(data.dni.replace(/\D/g, ''), 10);
    const legajoNum = parseInt(data.employeeNumber.replace(/\D/g, ''), 10);
    if (isNaN(dniNum) || dniNum <= 0) {
      throw new Error('El DNI debe ser numérico y válido.');
    }
    if (isNaN(legajoNum) || legajoNum <= 0) {
      throw new Error('El número de empleado / legajo debe ser numérico y válido.');
    }

    const { data: insData, error } = await this.insertWithIdentityFallback('agentes', 'agente_id', {
      dni: dniNum,
      legajo: legajoNum,
      apellido: data.apellidos.trim().toUpperCase(),
      nombre: data.nombres.trim().toUpperCase(),
      telefono: (data.telefono || '').trim(),
      email: (data.email || '').trim().toLowerCase(),
      fecha_nac: data.fecha_nac || data.fechaNacimiento || null,
      lugar_nacimiento: data.lugarNacimiento?.trim() || null,
      domicilio: data.domicilio?.trim() || '',
      titulo: data.titulo?.trim() || '',
      activo: true,
    });

    if (error || !insData) {
      throw new Error(error?.message || 'Error al crear agente en Supabase.');
    }

    const newAgent = this.mapDbAgent(insData);
    this.agents.push(newAgent);
    this.notifyListeners();
    return newAgent;
  }

  public async updateAgent(id: string, updates: Partial<Agent>): Promise<Agent> {
    const index = this.agents.findIndex((a) => a.id === id);
    if (index === -1) throw new Error('Agente no encontrado.');

    const current = this.agents[index];
    const numAgId = current.agente_id || parseInt(id.replace(/\D/g, ''), 10);
    if (!numAgId || isNaN(numAgId)) {
      throw new Error('Identificador de agente inválido en Supabase.');
    }

    const sbUpdates: Record<string, any> = {};
    if (updates.apellidos !== undefined) sbUpdates.apellido = updates.apellidos.trim().toUpperCase();
    if (updates.nombres !== undefined) sbUpdates.nombre = updates.nombres.trim().toUpperCase();
    if (updates.employeeNumber !== undefined) {
      const legNum = parseInt(updates.employeeNumber.replace(/\D/g, ''), 10);
      if (!isNaN(legNum) && legNum > 0) sbUpdates.legajo = legNum;
    }
    if (updates.dni !== undefined) {
      const dniNum = parseInt(updates.dni.replace(/\D/g, ''), 10);
      if (!isNaN(dniNum) && dniNum > 0) sbUpdates.dni = dniNum;
    }
    if (updates.telefono !== undefined) sbUpdates.telefono = updates.telefono.trim();
    if (updates.email !== undefined) sbUpdates.email = updates.email.trim().toLowerCase();
    if (updates.fechaNacimiento !== undefined) {
      sbUpdates.fecha_nac = updates.fechaNacimiento.trim() || null;
    }
    if (updates.lugarNacimiento !== undefined) {
      sbUpdates.lugar_nacimiento = updates.lugarNacimiento.trim() || null;
    }
    if (updates.domicilio !== undefined) sbUpdates.domicilio = updates.domicilio.trim();
    if (updates.titulo !== undefined) sbUpdates.titulo = updates.titulo.trim();
    if (updates.activo !== undefined) sbUpdates.activo = updates.activo;

    if (Object.keys(sbUpdates).length > 0) {
      const { data: updatedRow, error } = await supabase
        .from('agentes')
        .update(sbUpdates)
        .eq('agente_id', numAgId)
        .select()
        .single();

      if (error) {
        throw new Error(`Error actualizando agente en Supabase: ${error.message}`);
      }
      if (updatedRow) {
        this.agents[index] = this.mapDbAgent(updatedRow);
        this.notifyListeners();
        return this.agents[index];
      }
    }

    const apellidos = updates.apellidos !== undefined ? updates.apellidos.trim() : current.apellidos;
    const nombres = updates.nombres !== undefined ? updates.nombres.trim() : current.nombres;
    this.agents[index] = {
      ...current,
      ...updates,
      apellidos,
      nombres,
      fullName: `${apellidos}, ${nombres}`,
    };
    this.notifyListeners();
    return this.agents[index];
  }

  public async toggleAgentActive(id: string, activo: boolean): Promise<Agent> {
    const index = this.agents.findIndex((a) => a.id === id);
    if (index === -1) throw new Error('Agente no encontrado.');

    const numAgId = this.agents[index].agente_id || parseInt(id.replace(/\D/g, ''), 10);
    if (!numAgId || isNaN(numAgId)) {
      throw new Error('Identificador de agente inválido en Supabase.');
    }

    const { error } = await supabase
      .from('agentes')
      .update({ activo })
      .eq('agente_id', numAgId);

    if (error) {
      throw new Error(`Error al actualizar estado del agente en Supabase: ${error.message}`);
    }

    this.agents[index].activo = activo;
    this.notifyListeners();
    return this.agents[index];
  }

  public async importAgentsFromCSV(csvText: string): Promise<{
    totalRows: number;
    uniqueParsed: number;
    newAdded: number;
    updated: number;
    duplicatesSkipped: number;
  }> {
    const parseLine = (line: string): string[] => {
      const result: string[] = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
          if (inQuotes && line[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            inQuotes = !inQuotes;
          }
        } else if (char === ',' && !inQuotes) {
          result.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      result.push(current.trim());
      return result;
    };

    const clean = (s?: string) => (s ? s.replace(/^["'\s]+|["'\s]+$/g, '').trim() : '');
    const formatDob = (raw?: string): string => {
      if (!raw) return '';
      const parts = raw.split('/');
      if (parts.length === 3) {
        const day = parts[0].padStart(2, '0');
        const month = parts[1].padStart(2, '0');
        let year = parts[2].trim();
        if (year.length === 2) {
          const num = parseInt(year, 10);
          year = num > 30 ? '19' + year : '20' + year;
        }
        return `${year}-${month}-${day}`;
      }
      return raw;
    };

    const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length === 0) {
      throw new Error('El archivo CSV está vacío.');
    }

    let startIndex = 0;
    const firstRow = parseLine(lines[0]);
    if (
      firstRow.some(
        (col) =>
          col.toLowerCase().includes('correo') ||
          col.toLowerCase().includes('apellido') ||
          col.toLowerCase().includes('dni')
      )
    ) {
      startIndex = 1;
    }

    const dataRows = lines.slice(startIndex);
    const seenMap = new Map<string, Agent>();
    let duplicatesSkipped = 0;

    for (let i = dataRows.length - 1; i >= 0; i--) {
      const row = parseLine(dataRows[i]);
      if (row.length < 5) continue;

      const emailReal = clean(row[1]).toLowerCase();
      const apellidos = clean(row[2]);
      const nombres = clean(row[3]);
      const rawDni = clean(row[4]);
      const rawEmpNum = clean(row[5]);
      const telefono = clean(row[6]);
      const lugarNacimiento = clean(row[8]);
      const fechaNacimiento = clean(row[9]);

      const cleanDni = rawDni.replace(/[.\s-]/g, '');
      const cleanEmpNum = rawEmpNum.replace(/[.\s-]/g, '');

      if (!cleanDni && !cleanEmpNum) continue;

      const keyDni = cleanDni ? `DNI_${cleanDni}` : null;
      const keyEmp = cleanEmpNum ? `EMP_${cleanEmpNum}` : null;

      if ((keyDni && seenMap.has(keyDni)) || (keyEmp && seenMap.has(keyEmp))) {
        duplicatesSkipped++;
        continue;
      }

      const agent: Agent = {
        id: `agent-${cleanEmpNum || cleanDni}`,
        apellidos: apellidos || 'Sin Apellido',
        nombres: nombres || 'Sin Nombre',
        fullName: `${apellidos || 'Sin Apellido'}, ${nombres || 'Sin Nombre'}`,
        employeeNumber: cleanEmpNum || cleanDni,
        dni: cleanDni,
        telefono,
        email: emailReal,
        fechaNacimiento: formatDob(fechaNacimiento),
        lugarNacimiento,
        activo: true,
        hasAssignedPost: false,
        createdAt: new Date().toISOString(),
      };

      if (keyDni) seenMap.set(keyDni, agent);
      if (keyEmp) seenMap.set(keyEmp, agent);
      seenMap.set(`ID_${agent.id}`, agent);
    }

    const uniqueList = Array.from(new Set(Array.from(seenMap.values())));
    let newAdded = 0;
    let updated = 0;

    for (const newAg of uniqueList) {
      const existing = this.agents.find(
        (a) =>
          (newAg.dni && a.dni.replace(/\D/g, '') === newAg.dni.replace(/\D/g, '')) ||
          (newAg.employeeNumber && a.employeeNumber === newAg.employeeNumber)
      );

      const dniNum = parseInt(newAg.dni.replace(/\D/g, ''), 10);
      const legNum = parseInt(newAg.employeeNumber.replace(/\D/g, ''), 10);
      if (isNaN(dniNum) || dniNum <= 0) continue;

      const payload = {
        dni: dniNum,
        legajo: !isNaN(legNum) && legNum > 0 ? legNum : dniNum,
        apellido: newAg.apellidos.toUpperCase(),
        nombre: newAg.nombres.toUpperCase(),
        telefono: newAg.telefono || '',
        email: newAg.email || '',
        fecha_nac: newAg.fechaNacimiento || null,
        lugar_nacimiento: newAg.lugarNacimiento || null,
        activo: true,
      };

      if (existing?.agente_id) {
        await supabase.from('agentes').update(payload).eq('agente_id', existing.agente_id);
        updated++;
      } else {
        await supabase.from('agentes').upsert(payload, { onConflict: 'dni' });
        newAdded++;
      }
    }

    await this.refreshFromSupabase();

    return {
      totalRows: dataRows.length,
      uniqueParsed: uniqueList.length,
      newAdded,
      updated,
      duplicatesSkipped,
    };
  }

  // CARGOS CRUD
  public getCargos(): Cargo[] {
    return [...this.cargos].sort((a, b) => {
      const orderA = a.ordenVisual !== undefined ? a.ordenVisual : a.cargo_id || 99999;
      const orderB = b.ordenVisual !== undefined ? b.ordenVisual : b.cargo_id || 99999;
      return orderA - orderB;
    });
  }

  private async persistCargoOrdersToSupabase(changedCargos: Cargo[]): Promise<void> {
    if (changedCargos.length === 0) return;
    const chunkSize = 25;
    for (let i = 0; i < changedCargos.length; i += chunkSize) {
      const chunk = changedCargos.slice(i, i + chunkSize);
      await Promise.all(
        chunk.map(async (c) => {
          const numId = c.cargo_id || parseInt(c.id.replace(/\D/g, ''), 10);
          if (!numId || isNaN(numId)) return;
          const { error } = await supabase
            .from('cargos')
            .update({ orden_visual: c.ordenVisual })
            .eq('cargo_id', numId);
          if (error) {
            console.error(`Error persisting orden_visual for cargo ${numId}:`, error.message);
          }
        })
      );
    }
  }

  public async moveCargoUp(cargoId: string): Promise<Cargo[]> {
    const list = this.getCargos();
    const idx = list.findIndex((c) => c.id === cargoId);
    if (idx > 0) {
      const temp = list[idx];
      list[idx] = list[idx - 1];
      list[idx - 1] = temp;
      const changed: Cargo[] = [];
      list.forEach((c, i) => {
        const nextOrden = i + 1;
        if (c.ordenVisual !== nextOrden) {
          c.ordenVisual = nextOrden;
          c.orden_visual = nextOrden;
          changed.push(c);
        }
      });
      this.cargos = list;
      this.notifyListeners();
      await this.persistCargoOrdersToSupabase(changed);
    }
    return this.getCargos();
  }

  public async moveCargoDown(cargoId: string): Promise<Cargo[]> {
    const list = this.getCargos();
    const idx = list.findIndex((c) => c.id === cargoId);
    if (idx >= 0 && idx < list.length - 1) {
      const temp = list[idx];
      list[idx] = list[idx + 1];
      list[idx + 1] = temp;
      const changed: Cargo[] = [];
      list.forEach((c, i) => {
        const nextOrden = i + 1;
        if (c.ordenVisual !== nextOrden) {
          c.ordenVisual = nextOrden;
          c.orden_visual = nextOrden;
          changed.push(c);
        }
      });
      this.cargos = list;
      this.notifyListeners();
      await this.persistCargoOrdersToSupabase(changed);
    }
    return this.getCargos();
  }

  public async moveCargoToPosition(cargoId: string, targetPosition: number): Promise<Cargo[]> {
    const list = this.getCargos();
    const idx = list.findIndex((c) => c.id === cargoId);
    if (idx === -1) return list;
    const targetIdx = Math.max(0, Math.min(list.length - 1, targetPosition - 1));
    if (idx === targetIdx) return list;

    const [item] = list.splice(idx, 1);
    list.splice(targetIdx, 0, item);

    const changed: Cargo[] = [];
    list.forEach((c, i) => {
      const nextOrden = i + 1;
      if (c.ordenVisual !== nextOrden) {
        c.ordenVisual = nextOrden;
        c.orden_visual = nextOrden;
        changed.push(c);
      }
    });
    this.cargos = list;
    this.notifyListeners();
    await this.persistCargoOrdersToSupabase(changed);
    return this.getCargos();
  }

  public async reorderCargos(newOrder: Cargo[]): Promise<Cargo[]> {
    const changed: Cargo[] = [];
    newOrder.forEach((c, i) => {
      const nextOrden = i + 1;
      if (c.ordenVisual !== nextOrden) {
        c.ordenVisual = nextOrden;
        c.orden_visual = nextOrden;
        changed.push(c);
      }
    });
    this.cargos = newOrder;
    this.notifyListeners();
    await this.persistCargoOrdersToSupabase(changed);
    return this.getCargos();
  }

  public async resetCargosToCSVOrder(): Promise<Cargo[]> {
    await this.refreshFromSupabase();
    return this.getCargos();
  }

  public async createCargo(data: Omit<Cargo, 'id'>): Promise<Cargo> {
    const rawCurso = (data.curso_raw || data.curso.replace(/\D/g, '') || data.curso.trim())
      .slice(0, 2);
    const rawSeccion = (data.seccion_raw || data.seccion.replace(/Div\.\s*/i, '').replace(/°/g, '').trim())
      .slice(0, 2);
    const turnoCode = turnoLabelToCode(data.turno, data.turno_codigo);
    const secuenciaNum = parseInt(String(data.secuencia).replace(/\D/g, ''), 10) || 1;
    const obligacionesNum = parseInt(String(data.obligaciones || '1').replace(/\D/g, ''), 10) || 1;
    const maxOrden = this.cargos.reduce((max, c) => Math.max(max, c.ordenVisual || 0), 0);
    const nextOrden = data.ordenVisual || maxOrden + 1;

    const { data: insCargo, error: cgErr } = await this.insertWithIdentityFallback(
      'cargos',
      'cargo_id',
      {
        secuencia: secuenciaNum,
        turno: turnoCode,
        curso: rawCurso || null,
        seccion: rawSeccion || null,
        descripccion: data.descripcion.trim().slice(0, 150),
        obligaciones: obligacionesNum,
        activo: true,
        tiene_art: Boolean(data.tieneArticulacion),
        orden_visual: nextOrden,
      }
    );

    if (cgErr || !insCargo) {
      throw new Error(cgErr?.message || 'Error al crear cargo en Supabase.');
    }

    const { data: insPuesto, error: puErr } = await this.insertWithIdentityFallback(
      'puestos',
      'puesto_id',
      {
        cargo_id: insCargo.cargo_id,
        activo: true,
      }
    );

    if (puErr || !insPuesto) {
      throw new Error(puErr?.message || 'Cargo creado pero ocurrió un error al crear el puesto en Supabase.');
    }

    // Insertar horarios asociados si fueron cargados en el formulario
    const regularHorarios = data.horarios || [];
    const artHorariosList: Horario[] = data.tieneArticulacion
      ? data.horariosArticulacion && data.horariosArticulacion.length > 0
        ? data.horariosArticulacion
        : data.horarioArticulacion
        ? [data.horarioArticulacion]
        : []
      : [];

    const horarioRows = [
      ...regularHorarios.map((h) => ({
        cargo_id: insCargo.cargo_id,
        dia: h.dia,
        hora_desde: h.horaIngreso.length === 5 ? `${h.horaIngreso}:00` : h.horaIngreso,
        hora_hasta: h.horaSalida.length === 5 ? `${h.horaSalida}:00` : h.horaSalida,
        articulacion: false,
      })),
      ...artHorariosList.map((h) => ({
        cargo_id: insCargo.cargo_id,
        dia: h.dia,
        hora_desde: h.horaIngreso.length === 5 ? `${h.horaIngreso}:00` : h.horaIngreso,
        hora_hasta: h.horaSalida.length === 5 ? `${h.horaSalida}:00` : h.horaSalida,
        articulacion: true,
      })),
    ];

    if (horarioRows.length > 0) {
      const { error: hrErr } = await this.insertManyWithIdentityFallback(
        'horarios_cargos',
        'horario_id',
        horarioRows
      );
      if (hrErr) {
        console.error('Error al insertar horarios del cargo en Supabase:', hrErr.message);
      }
    }

    await this.refreshFromSupabase();
    const createdCargo =
      this.cargos.find((c) => c.cargo_id === insCargo.cargo_id) ||
      this.mapDbCargo(insCargo, new Map());
    return createdCargo;
  }

  public async updateCargo(id: string, updates: Partial<Cargo>): Promise<Cargo> {
    const index = this.cargos.findIndex((c) => c.id === id);
    if (index === -1) throw new Error('Cargo no encontrado.');

    const cargoItem = this.cargos[index];
    const numCargoId = cargoItem.cargo_id || parseInt(id.replace(/\D/g, ''), 10);
    if (!numCargoId || isNaN(numCargoId)) {
      throw new Error('Identificador de cargo inválido en Supabase.');
    }

    const sbUpdates: Record<string, any> = {};
    if (updates.descripcion !== undefined) {
      sbUpdates.descripccion = updates.descripcion.trim().slice(0, 150);
    }
    if (updates.secuencia !== undefined) {
      sbUpdates.secuencia = parseInt(String(updates.secuencia).replace(/\D/g, ''), 10) || 1;
    }
    if (updates.turno !== undefined) {
      sbUpdates.turno = turnoLabelToCode(updates.turno, updates.turno_codigo);
    }
    if (updates.curso !== undefined) {
      const cVal = (updates.curso.replace(/\D/g, '') || updates.curso.trim()).slice(0, 2);
      sbUpdates.curso = cVal || null;
    }
    if (updates.seccion !== undefined) {
      const sVal = updates.seccion.replace(/Div\.\s*/i, '').replace(/°/g, '').trim().slice(0, 2);
      sbUpdates.seccion = sVal || null;
    }
    if (updates.obligaciones !== undefined) {
      sbUpdates.obligaciones = parseInt(String(updates.obligaciones).replace(/\D/g, ''), 10) || 1;
    }
    if (updates.activo !== undefined) sbUpdates.activo = updates.activo;
    if (updates.tieneArticulacion !== undefined) sbUpdates.tiene_art = updates.tieneArticulacion;

    if (Object.keys(sbUpdates).length > 0) {
      const { error } = await supabase
        .from('cargos')
        .update(sbUpdates)
        .eq('cargo_id', numCargoId);
      if (error) {
        throw new Error(`Error actualizando cargo en Supabase: ${error.message}`);
      }
    }

    const shouldSyncHorarios =
      updates.horarios !== undefined ||
      updates.tieneArticulacion !== undefined ||
      updates.horarioArticulacion !== undefined ||
      updates.horariosArticulacion !== undefined;

    if (shouldSyncHorarios) {
      const nextHorarios = updates.horarios ?? cargoItem.horarios ?? [];
      const nextTieneArt = updates.tieneArticulacion ?? cargoItem.tieneArticulacion ?? false;
      const nextHorArt = updates.horarioArticulacion ?? cargoItem.horarioArticulacion;
      const nextHorArtList = updates.horariosArticulacion ?? cargoItem.horariosArticulacion;
      const horRes = await this.saveCargoHorarios(
        numCargoId,
        nextHorarios,
        nextTieneArt,
        nextHorArt,
        nextHorArtList
      );
      if (!horRes.success) {
        throw new Error(horRes.error || 'Error actualizando horarios del cargo en Supabase.');
      }
    }

    await this.refreshFromSupabase();
    return this.cargos.find((c) => c.cargo_id === numCargoId) || this.cargos[index];
  }

  public async saveCargoHorarios(
    cargoId: string | number,
    horarios: Horario[],
    tieneArticulacion: boolean,
    horarioArticulacion?: Horario | null,
    horariosArticulacion?: Horario[]
  ): Promise<{ success: boolean; error?: string }> {
    const idStr = String(cargoId);
    const cargo = this.cargos.find(
      (c) => c.id === idStr || c.id === `cargo-${idStr}` || c.cargo_id === Number(idStr)
    );

    if (!cargo) {
      return { success: false, error: `Cargo ${cargoId} no encontrado.` };
    }

    const numCargoId = cargo.cargo_id || Number(cargo.id.replace('cargo-', ''));
    if (!numCargoId || isNaN(numCargoId)) {
      return { success: false, error: `Identificador de cargo inválido: ${cargoId}` };
    }

    const cleanRegular: Horario[] = horarios.map((h, idx) => ({
      id: h.id || `h-${cargo.id}-${idx}-${Date.now()}`,
      cargo_id: numCargoId,
      dia: h.dia,
      horaIngreso: h.horaIngreso,
      horaSalida: h.horaSalida,
      articulacion: false,
    }));

    let cleanArtList: Horario[] = [];
    if (tieneArticulacion) {
      if (horariosArticulacion && horariosArticulacion.length > 0) {
        cleanArtList = horariosArticulacion.map((ha, idx) => ({
          id: ha.id || `h-art-${cargo.id}-${idx}-${Date.now()}`,
          cargo_id: numCargoId,
          dia: ha.dia,
          horaIngreso: ha.horaIngreso,
          horaSalida: ha.horaSalida,
          articulacion: true,
        }));
      } else if (horarioArticulacion && horarioArticulacion.dia && horarioArticulacion.horaIngreso) {
        cleanArtList = [
          {
            id: horarioArticulacion.id || `h-art-${cargo.id}-${Date.now()}`,
            cargo_id: numCargoId,
            dia: horarioArticulacion.dia,
            horaIngreso: horarioArticulacion.horaIngreso,
            horaSalida: horarioArticulacion.horaSalida || horarioArticulacion.horaIngreso,
            articulacion: true,
          },
        ];
      }
    }

    try {
      const { error: updErr } = await supabase
        .from('cargos')
        .update({ tiene_art: tieneArticulacion })
        .eq('cargo_id', numCargoId);
      if (updErr) {
        return { success: false, error: updErr.message };
      }

      const { error: delErr } = await supabase
        .from('horarios_cargos')
        .delete()
        .eq('cargo_id', numCargoId);
      if (delErr) {
        return { success: false, error: delErr.message };
      }

      const rowsToInsert = [
        ...cleanRegular.map((h) => ({
          cargo_id: numCargoId,
          dia: h.dia,
          hora_desde: h.horaIngreso.length === 5 ? `${h.horaIngreso}:00` : h.horaIngreso,
          hora_hasta: h.horaSalida.length === 5 ? `${h.horaSalida}:00` : h.horaSalida,
          articulacion: false,
        })),
        ...cleanArtList.map((h) => ({
          cargo_id: numCargoId,
          dia: h.dia,
          hora_desde: h.horaIngreso.length === 5 ? `${h.horaIngreso}:00` : h.horaIngreso,
          hora_hasta: h.horaSalida.length === 5 ? `${h.horaSalida}:00` : h.horaSalida,
          articulacion: true,
        })),
      ];

      if (rowsToInsert.length > 0) {
        const { data: insertedRows, error: insErr } = await this.insertManyWithIdentityFallback(
          'horarios_cargos',
          'horario_id',
          rowsToInsert
        );

        if (insErr) {
          return { success: false, error: insErr.message };
        }

        if (insertedRows) {
          cargo.horarios = insertedRows
            .filter((h: any) => !h.articulacion)
            .map((h: any) => ({
              id: `horario-${h.horario_id}`,
              horario_id: h.horario_id,
              cargo_id: h.cargo_id,
              dia: h.dia,
              horaIngreso: (h.hora_desde || '').slice(0, 5),
              horaSalida: (h.hora_hasta || '').slice(0, 5),
              articulacion: false,
            }));
          const artDb = insertedRows.filter((h: any) => h.articulacion);
          cargo.horariosArticulacion = artDb.map((h: any) => ({
            id: `horario-${h.horario_id}`,
            horario_id: h.horario_id,
            cargo_id: h.cargo_id,
            dia: h.dia,
            horaIngreso: (h.hora_desde || '').slice(0, 5),
            horaSalida: (h.hora_hasta || '').slice(0, 5),
            articulacion: true,
          }));
          cargo.horarioArticulacion = cargo.horariosArticulacion[0];
        }
      } else {
        cargo.horarios = [];
        cargo.horarioArticulacion = undefined;
        cargo.horariosArticulacion = [];
      }

      cargo.tieneArticulacion = tieneArticulacion;
      cargo.tiene_art = tieneArticulacion;
      this.notifyListeners();

      return { success: true };
    } catch (err: any) {
      console.error('Error sincronizando horarios con Supabase:', err);
      return { success: false, error: err?.message || 'Error inesperado sincronizando horarios.' };
    }
  }

  public async saveBatchHorarios(
    updates: Array<{
      cargoId: string | number;
      horarios: Horario[];
      tieneArticulacion: boolean;
      horarioArticulacion?: Horario | null;
      horariosArticulacion?: Horario[];
    }>
  ): Promise<{ success: boolean; count: number }> {
    let successCount = 0;
    for (const item of updates) {
      const res = await this.saveCargoHorarios(
        item.cargoId,
        item.horarios,
        item.tieneArticulacion,
        item.horarioArticulacion,
        item.horariosArticulacion
      );
      if (res.success) successCount++;
    }
    return { success: true, count: successCount };
  }

  public async deleteCargo(id: string): Promise<void> {
    const puesto = this.puestos.find((p) => p.cargoId === id && p.agentesAsignados.length > 0);
    if (puesto) {
      throw new Error(
        'No es posible eliminar un cargo que tiene agentes asignados. Desasigne primero los agentes o desactive el cargo.'
      );
    }
    const cargoToDelete = this.cargos.find((c) => c.id === id);
    const numCargoId = cargoToDelete?.cargo_id || parseInt(id.replace(/\D/g, ''), 10);

    if (numCargoId && !isNaN(numCargoId)) {
      const { error: puErr } = await supabase
        .from('puestos')
        .update({ activo: false })
        .eq('cargo_id', numCargoId);
      if (puErr) {
        throw new Error(`Error al desactivar puesto en Supabase: ${puErr.message}`);
      }

      const { error: cgErr } = await supabase
        .from('cargos')
        .update({ activo: false })
        .eq('cargo_id', numCargoId);
      if (cgErr) {
        throw new Error(`Error al desactivar cargo en Supabase: ${cgErr.message}`);
      }
    }

    this.cargos = this.cargos.filter((c) => c.id !== id);
    this.puestos = this.puestos.filter((p) => p.cargoId !== id);
    this.notifyListeners();
  }

  // PUESTOS & ASIGNACIONES
  public getPuestos(): Puesto[] {
    return this.puestos;
  }

  public getPuestosCargos(): PuestoCargo[] {
    return this.puestosCargos;
  }

  public getPuestoByCargoId(cargoId: string): Puesto | null {
    return this.puestos.find((p) => p.cargoId === cargoId) || null;
  }

  public async getOrCreatePuestoForCargo(cargoId: string): Promise<Puesto> {
    const existing = this.puestos.find((p) => p.cargoId === cargoId);
    if (existing) return existing;

    const cargo = this.cargos.find((c) => c.id === cargoId);
    const numCargoId = cargo?.cargo_id || parseInt(cargoId.replace(/\D/g, ''), 10);
    if (!numCargoId || isNaN(numCargoId)) {
      throw new Error('Cargo no encontrado para crear puesto.');
    }

    const { data: insPuesto, error } = await this.insertWithIdentityFallback(
      'puestos',
      'puesto_id',
      { cargo_id: numCargoId, activo: true }
    );

    if (error || !insPuesto) {
      throw new Error(error?.message || 'Error al crear puesto en Supabase.');
    }

    const newPuesto: Puesto = {
      id: `puesto-${insPuesto.puesto_id}`,
      puesto_id: insPuesto.puesto_id,
      cargoId: `cargo-${numCargoId}`,
      cargo_id: numCargoId,
      agentesAsignados: [],
      activo: true,
      createdAt: insPuesto.created_at || new Date().toISOString(),
    };
    this.puestos.push(newPuesto);
    this.notifyListeners();
    return newPuesto;
  }

  public async assignAgentToPuesto(
    puestoId: string,
    agenteId: string,
    situacionRevista: 'Titular' | 'Interino' | 'Suplente' = 'Titular'
  ): Promise<Puesto> {
    const index = this.puestos.findIndex((p) => p.id === puestoId);
    if (index === -1) throw new Error('Puesto no encontrado.');

    const currentPuesto = this.puestos[index];
    const exists = currentPuesto.agentesAsignados.some((a) => a.agenteId === agenteId);
    if (exists) {
      throw new Error('El agente ya se encuentra asignado a este puesto.');
    }

    const numPuestoId = currentPuesto.puesto_id || parseInt(puestoId.replace(/\D/g, ''), 10);
    const agObj = this.agents.find((a) => a.id === agenteId);
    const numAgenteId = agObj?.agente_id || parseInt(agenteId.replace(/\D/g, ''), 10);

    if (!numPuestoId || isNaN(numPuestoId) || !numAgenteId || isNaN(numAgenteId)) {
      throw new Error('Identificadores inválidos de puesto o agente para Supabase.');
    }

    const nextOrden = currentPuesto.agentesAsignados.length + 1;
    const today = formatYMD(new Date());

    const { data: insPC, error } = await this.insertWithIdentityFallback(
      'puestos_cargos',
      'puestos_cargos_id',
      {
        puesto_id: numPuestoId,
        agente_id: numAgenteId,
        orden: nextOrden,
        sit_revista: situacionRevista,
        fecha_alta: today,
        activo: true,
      }
    );

    if (error || !insPC) {
      throw new Error(error?.message || 'Error al asignar agente en Supabase.');
    }

    currentPuesto.agentesAsignados.push({
      agenteId: `ag-${numAgenteId}`,
      orden: nextOrden,
      fechaAsignacion: today,
      situacionRevista,
    });

    this.puestosCargos.push({
      puestos_cargos_id: insPC.puestos_cargos_id,
      puesto_id: numPuestoId,
      agente_id: numAgenteId,
      orden: nextOrden,
      sit_revista: situacionRevista,
      fecha_alta: today,
      activo: true,
    });

    this.notifyListeners();
    return currentPuesto;
  }

  public async removeAgentFromPuesto(puestoId: string, agenteId: string): Promise<Puesto> {
    const index = this.puestos.findIndex((p) => p.id === puestoId);
    if (index === -1) throw new Error('Puesto no encontrado.');

    const currentPuesto = this.puestos[index];
    const numPuestoId = currentPuesto.puesto_id || parseInt(puestoId.replace(/\D/g, ''), 10);
    const agObj = this.agents.find((a) => a.id === agenteId);
    const numAgenteId = agObj?.agente_id || parseInt(agenteId.replace(/\D/g, ''), 10);

    if (!numPuestoId || isNaN(numPuestoId) || !numAgenteId || isNaN(numAgenteId)) {
      throw new Error('Identificadores inválidos para desasignar agente en Supabase.');
    }

    const { error } = await supabase
      .from('puestos_cargos')
      .update({ activo: false })
      .eq('puesto_id', numPuestoId)
      .eq('agente_id', numAgenteId)
      .eq('activo', true);

    if (error) {
      throw new Error(error.message || 'Error al desasignar agente en Supabase.');
    }

    this.puestosCargos = this.puestosCargos.map((pc) =>
      pc.puesto_id === numPuestoId && pc.agente_id === numAgenteId ? { ...pc, activo: false } : pc
    );

    const remaining = currentPuesto.agentesAsignados
      .filter((a) => a.agenteId !== agenteId)
      .map((a, i) => ({ ...a, orden: i + 1 }));

    currentPuesto.agentesAsignados = remaining;

    // Re-indexar orden de los agentes restantes en Supabase
    await Promise.all(
      remaining.map(async (asig) => {
        const remAgId = parseInt(asig.agenteId.replace(/\D/g, ''), 10);
        if (!isNaN(remAgId)) {
          await supabase
            .from('puestos_cargos')
            .update({ orden: asig.orden })
            .eq('puesto_id', numPuestoId)
            .eq('agente_id', remAgId)
            .eq('activo', true);
        }
      })
    );

    this.notifyListeners();
    return currentPuesto;
  }

  public async reorderPuestoAgents(puestoId: string, orderedAgentIds: string[]): Promise<Puesto> {
    const index = this.puestos.findIndex((p) => p.id === puestoId);
    if (index === -1) throw new Error('Puesto no encontrado.');

    const currentPuesto = this.puestos[index];
    const numPuestoId = currentPuesto.puesto_id || parseInt(puestoId.replace(/\D/g, ''), 10);

    const newAssignments = orderedAgentIds.map((agId, i) => {
      const existing = currentPuesto.agentesAsignados.find((a) => a.agenteId === agId);
      return {
        agenteId: agId,
        orden: i + 1,
        fechaAsignacion: existing?.fechaAsignacion || formatYMD(new Date()),
        situacionRevista: existing?.situacionRevista || 'Titular',
      };
    });

    if (numPuestoId && !isNaN(numPuestoId)) {
      await Promise.all(
        orderedAgentIds.map(async (agId, idx) => {
          const numAgId = parseInt(agId.replace(/\D/g, ''), 10);
          if (!isNaN(numAgId)) {
            const { error } = await supabase
              .from('puestos_cargos')
              .update({ orden: idx + 1 })
              .eq('puesto_id', numPuestoId)
              .eq('agente_id', numAgId)
              .eq('activo', true);
            if (error) {
              console.error('Error reordenando agente en puestos_cargos:', error.message);
            }
          }
        })
      );
    }

    currentPuesto.agentesAsignados = newAssignments;
    this.notifyListeners();
    return currentPuesto;
  }

  // SOLICITUDES DE LICENCIAS
  public getRequests(): LicenseRequest[] {
    return [...this.requests].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  public async getRequestsByEmployee(employeeNumber: string): Promise<LicenseRequest[]> {
    await this.initialize();
    await this.refreshRequestsFromSupabase(false);

    const trimmed = employeeNumber.trim().toLowerCase();
    const ag = this.agents.find(
      (a) =>
        a.employeeNumber.toLowerCase() === trimmed ||
        a.dni.toLowerCase() === trimmed ||
        a.dni.replace(/\D/g, '') === trimmed.replace(/\D/g, '') ||
        a.employeeNumber.replace(/\D/g, '') === trimmed.replace(/\D/g, '')
    );

    const list = this.requests
      .filter((r) => {
        if (r.status === 'Eliminada') return false;
        if (r.employeeNumber.toLowerCase() === trimmed) return true;
        if (ag && (r.agentDni === ag.dni || r.employeeNumber === ag.employeeNumber)) return true;
        return false;
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return list;
  }

  public async createLicenseRequest(
    data: Omit<LicenseRequest, 'id' | 'createdAt' | 'status' | 'source' | 'historialEstados'> & { id?: string }
  ): Promise<LicenseRequest> {
    const codeId = data.id || 'SOL-' + new Date().getFullYear() + '-' + Math.floor(100 + Math.random() * 900);
    const newReq: LicenseRequest = {
      ...data,
      id: codeId,
      status: 'Pendiente',
      createdAt: new Date().toISOString(),
      source: 'Solicitud',
      historialEstados: [],
    };

    const empClean = (newReq.employeeNumber || '').trim().toLowerCase();
    const dniDigits = (newReq.agentDni || '').replace(/\D/g, '');
    let ag = this.agents.find(
      (a) =>
        (empClean && a.employeeNumber.trim().toLowerCase() === empClean) ||
        (dniDigits && a.dni.replace(/\D/g, '') === dniDigits)
    );
    if (!ag && (empClean || dniDigits)) {
      ag = (await this.verifyAgent(newReq.employeeNumber || newReq.agentDni)) || undefined;
    }
    if (!ag?.agente_id) {
      throw new Error('No se pudo identificar el agente en la base de datos de Supabase.');
    }

    const lt = this.licenseTypes.find((t) => t.id === newReq.licenseTypeId);
    const typeIdNum = lt?.tipo_licencia_id || parseInt(newReq.licenseTypeId.replace(/\D/g, ''), 10) || 1;
    const obligacionesNum =
      newReq.cantidadObligaciones ||
      parseInt(newReq.obligaciones || newReq.obligations || '1', 10) ||
      1;

    const puestosArray =
      newReq.postsSelection && newReq.postsSelection !== 'ALL'
        ? newReq.postsSelection
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : ['ALL'];

    const { data: insData, error } = await this.insertWithIdentityFallback(
      'solicitud_licencias',
      'solicitud_licencia_id',
      {
        agente_id: ag.agente_id,
        tipo_licencia_id: typeIdNum,
        puestos_id: puestosArray,
        fecha_desde: newReq.dateFrom,
        fecha_hasta: newReq.dateTo,
        articulacion: newReq.isArticulation || false,
        obligaciones: obligacionesNum,
        detalle_solicitud: newReq.note || newReq.detail || '',
        codigo: newReq.id,
        estado: 'Pendiente',
        signature_data_url: newReq.signatureDriveUrl || newReq.signatureDataUrl || null,
        justificacion_url: newReq.justificationDriveUrl || newReq.justificationDataUrl || null,
        fecha_carga: newReq.createdAt,
      }
    );

    if (error) {
      throw new Error(`Error al guardar solicitud en Supabase: ${error.message}`);
    }

    if (insData && insData.codigo) {
      newReq.id = insData.codigo;
    }

    this.requests.unshift(newReq);

    this.auditLogs.unshift({
      id: 'log-' + Date.now(),
      action: 'CREACION_SOLICITUD',
      targetRequestId: newReq.id,
      employeeNumber: newReq.employeeNumber,
      agentName: newReq.agentName,
      reason: `Solicitud creada para ${newReq.postDescription}`,
      timestamp: new Date().toISOString(),
    });

    this.notifyListeners();
    return newReq;
  }

  public updateLicenseRequest(id: string, updates: Partial<LicenseRequest>): LicenseRequest {
    const index = this.requests.findIndex((r) => r.id === id);
    if (index === -1) throw new Error('Solicitud no encontrada.');
    this.requests[index] = { ...this.requests[index], ...updates };

    const numId = parseInt(id.replace(/\D/g, ''), 10);
    const sbPayload: Record<string, any> = {};
    if (updates.status !== undefined) sbPayload.estado = updates.status;
    if (updates.note !== undefined || updates.detail !== undefined) {
      sbPayload.detalle_solicitud = updates.note || updates.detail;
    }

    if (Object.keys(sbPayload).length > 0) {
      const q = supabase.from('solicitud_licencias').update(sbPayload);
      const reqExec =
        !isNaN(numId) && numId > 0 && !id.startsWith('SOL-')
          ? q.or(`codigo.eq.${id},solicitud_licencia_id.eq.${numId}`)
          : q.eq('codigo', id);
      reqExec.then(({ error }) => {
        if (error) console.error('Supabase update solicitud_licencias error:', error.message);
      });
    }

    this.notifyListeners();
    return this.requests[index];
  }

  public updateRequestStatus(
    requestId: string,
    newStatus: LicenseStatus,
    usuarioEmail: string,
    detalleObservacion: string
  ): LicenseRequest {
    const index = this.requests.findIndex((r) => r.id === requestId);
    if (index === -1) throw new Error('Solicitud no encontrada.');

    const req = this.requests[index];
    const prevStatus = req.status;

    const historyEntry: HistorialEstadoSolicitud = {
      id: 'h-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
      estadoAnterior: prevStatus,
      estadoNuevo: newStatus,
      fecha: new Date().toISOString(),
      usuario: usuarioEmail,
      detalle: detalleObservacion.trim() || 'Modificación de estado desde panel administrativo.',
    };

    req.status = newStatus;
    if (!req.historialEstados) req.historialEstados = [];
    req.historialEstados.unshift(historyEntry);

    supabase
      .from('solicitud_licencias')
      .update({
        estado: newStatus,
        detalle_estado: detalleObservacion.trim() || null,
      })
      .eq('codigo', req.id)
      .then(({ error }) => {
        if (error) console.error('Supabase update solicitud_licencias error:', error.message);
      });

    this.auditLogs.unshift({
      id: 'log-' + Date.now(),
      action: 'CAMBIO_ESTADO',
      targetRequestId: req.id,
      employeeNumber: req.employeeNumber,
      agentName: req.agentName,
      reason: `Estado cambiado de ${prevStatus} a ${newStatus}. ${detalleObservacion}`,
      usuario: usuarioEmail,
      timestamp: new Date().toISOString(),
    });

    this.notifyListeners();
    return req;
  }

  public async justifyAuthorizedRequest(
    requestId: string,
    employeeNumber: string,
    file: { name: string; size: string; dataUrl: string; driveUrl?: string; driveFileId?: string },
    observacion?: string
  ): Promise<LicenseRequest> {
    await this.initialize();
    let index = this.requests.findIndex((r) => r.id === requestId);
    if (index === -1) {
      await this.refreshRequestsFromSupabase(false);
      index = this.requests.findIndex((r) => r.id === requestId);
    }
    if (index === -1) throw new Error('Solicitud no encontrada.');

    const req = this.requests[index];

    const cleanParam = (employeeNumber || '').trim().toLowerCase();
    const cleanDigits = cleanParam.replace(/\D/g, '');

    const reqEmp = (req.employeeNumber || '').trim().toLowerCase();
    const reqEmpDigits = reqEmp.replace(/\D/g, '');
    const reqDni = (req.agentDni || '').trim().toLowerCase();
    const reqDniDigits = reqDni.replace(/\D/g, '');

    const agentByParam = this.agents.find((a) => {
      const aEmp = (a.employeeNumber || '').trim().toLowerCase();
      const aDni = (a.dni || '').trim().toLowerCase();
      const aEmpDigits = aEmp.replace(/\D/g, '');
      const aDniDigits = aDni.replace(/\D/g, '');
      return (
        (cleanParam && (aEmp === cleanParam || aDni === cleanParam)) ||
        (cleanDigits && (aEmpDigits === cleanDigits || aDniDigits === cleanDigits))
      );
    });

    const agentByReq = this.agents.find((a) => {
      const aEmp = (a.employeeNumber || '').trim().toLowerCase();
      const aDni = (a.dni || '').trim().toLowerCase();
      const aEmpDigits = aEmp.replace(/\D/g, '');
      const aDniDigits = aDni.replace(/\D/g, '');
      return (
        (reqEmp && (aEmp === reqEmp || aDni === reqEmp)) ||
        (reqDni && (aEmp === reqDni || aDni === reqDni)) ||
        (reqEmpDigits && (aEmpDigits === reqEmpDigits || aDniDigits === reqEmpDigits)) ||
        (reqDniDigits && (aEmpDigits === reqDniDigits || aDniDigits === reqDniDigits))
      );
    });

    const isDirectMatch =
      (cleanParam && (reqEmp === cleanParam || reqDni === cleanParam)) ||
      (cleanDigits && (reqEmpDigits === cleanDigits || reqDniDigits === cleanDigits));

    const isCrossAgentMatch =
      (agentByParam && agentByReq && (agentByParam.id === agentByReq.id || agentByParam.dni === agentByReq.dni)) ||
      (agentByParam &&
        ((agentByParam.employeeNumber && agentByParam.employeeNumber.trim().toLowerCase() === reqEmp) ||
          (agentByParam.dni && agentByParam.dni.trim().toLowerCase() === reqDni) ||
          (cleanDigits && agentByParam.dni.replace(/\D/g, '') === reqDniDigits)));

    const isAdmin = authService.isAdminOrSuperadmin();

    if (!isDirectMatch && !isCrossAgentMatch && !isAdmin) {
      throw new Error('No tiene permisos para justificar esta solicitud.');
    }

    const prevStatus = req.status;
    req.justificationName = file.name;
    req.justificationDataUrl = file.driveUrl || file.dataUrl;
    req.justificationDriveUrl = file.driveUrl;
    req.justificationDriveFileId = file.driveFileId;
    req.status = 'Justificada';

    const historyEntry: HistorialEstadoSolicitud = {
      id: 'h-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
      estadoAnterior: prevStatus,
      estadoNuevo: 'Justificada',
      fecha: new Date().toISOString(),
      usuario: `Agente Leg. ${req.employeeNumber || employeeNumber}`,
      detalle: observacion?.trim()
        ? `Comprobante de justificación adjuntado (${file.name}): ${observacion.trim()}`
        : `Comprobante de justificación adjuntado por el agente (${file.name}).`,
    };

    if (!req.historialEstados) req.historialEstados = [];
    req.historialEstados.unshift(historyEntry);

    const { error } = await supabase
      .from('solicitud_licencias')
      .update({
        estado: 'Justificada',
        justificacion_url: file.driveUrl || file.dataUrl,
        detalle_estado: observacion?.trim() || `Comprobante adjuntado (${file.name})`,
      })
      .eq('codigo', req.id);

    if (error) {
      console.error('Supabase justify error:', error.message);
    }

    this.auditLogs.unshift({
      id: 'log-' + Date.now(),
      action: 'CAMBIO_ESTADO',
      targetRequestId: req.id,
      employeeNumber: req.employeeNumber,
      agentName: req.agentName,
      reason: `El agente adjuntó comprobante de justificación (${file.name}). Estado actualizado a Justificada.`,
      usuario: `Agente Leg. ${req.employeeNumber || employeeNumber}`,
      timestamp: new Date().toISOString(),
    });

    this.notifyListeners();
    return req;
  }

  public bulkUpdateStatus(
    requestIds: string[],
    newStatus: LicenseStatus,
    usuarioEmail: string,
    detalleObservacion: string
  ): { updatedCount: number } {
    let count = 0;
    for (const id of requestIds) {
      const index = this.requests.findIndex((r) => r.id === id);
      if (index !== -1) {
        const req = this.requests[index];
        const prevStatus = req.status;

        const historyEntry: HistorialEstadoSolicitud = {
          id: 'h-' + Date.now() + '-' + count,
          estadoAnterior: prevStatus,
          estadoNuevo: newStatus,
          fecha: new Date().toISOString(),
          usuario: usuarioEmail,
          detalle: `Modificación masiva: ${detalleObservacion || 'Cambio por lote de solicitudes.'}`,
        };

        req.status = newStatus;
        if (!req.historialEstados) req.historialEstados = [];
        req.historialEstados.unshift(historyEntry);
        count++;
      }
    }

    supabase
      .from('solicitud_licencias')
      .update({
        estado: newStatus,
        detalle_estado: detalleObservacion || 'Modificación masiva de estado',
      })
      .in('codigo', requestIds)
      .then(({ error }) => {
        if (error) console.error('Supabase bulk update error:', error.message);
      });

    this.auditLogs.unshift({
      id: 'log-' + Date.now(),
      action: 'MODIFICACION_MASIVA',
      reason: `Se modificó en lote el estado de ${count} solicitudes a "${newStatus}". Detalle: ${detalleObservacion}`,
      usuario: usuarioEmail,
      timestamp: new Date().toISOString(),
    });

    this.notifyListeners();
    return { updatedCount: count };
  }

  public async deleteLicenseRequest(
    requestId: string,
    _employeeNumber: string,
    reason: string
  ): Promise<boolean> {
    const index = this.requests.findIndex((r) => r.id === requestId);
    if (index === -1) throw new Error('La solicitud no fue encontrada.');

    const req = this.requests[index];
    if (req.status !== 'Pendiente' && req.status !== 'Rechazada') {
      throw new Error(`No se permite eliminar solicitudes en estado "${req.status}".`);
    }

    const deletedAt = new Date().toISOString();
    const { error } = await supabase
      .from('solicitud_licencias')
      .update({
        estado: 'Eliminada',
        deleted_at: deletedAt,
        detalle_estado: reason || 'Eliminada por el agente',
      })
      .eq('codigo', requestId);

    if (error) {
      throw new Error(`Error al eliminar solicitud en Supabase: ${error.message}`);
    }

    req.status = 'Eliminada';
    req.deletedAt = deletedAt;

    this.auditLogs.unshift({
      id: 'log-' + Date.now(),
      action: 'ELIMINACION_SOLICITUD',
      targetRequestId: requestId,
      employeeNumber: req.employeeNumber,
      agentName: req.agentName,
      reason: reason || 'Eliminada por el agente',
      timestamp: new Date().toISOString(),
    });

    this.notifyListeners();
    return true;
  }

  public getRequestsWithJustifications(): LicenseRequest[] {
    return this.requests.filter(
      (r) =>
        (Boolean(r.justificationName) ||
          Boolean(r.justificationDataUrl) ||
          Boolean(r.justificationDriveUrl) ||
          Boolean(r.justificationDriveFileId)) &&
        r.status !== 'Eliminada'
    );
  }

  public deleteJustificationFiles(
    requestIds: string[],
    superadminEmail: string,
    reason: string = 'Eliminación administrativa de comprobantes por Superadmin',
    deleteWholeRequest: boolean = false
  ): { deletedCount: number; affectedRequests: LicenseRequest[] } {
    let count = 0;
    const affected: LicenseRequest[] = [];

    for (const id of requestIds) {
      const req = this.requests.find((r) => r.id === id);
      if (
        req &&
        (req.justificationName ||
          req.justificationDataUrl ||
          req.justificationDriveUrl ||
          req.justificationDriveFileId)
      ) {
        const fileName = req.justificationName || 'comprobante_adjunto';
        const prevStatus = req.status;

        if (deleteWholeRequest) {
          req.status = 'Eliminada';
          req.deletedAt = new Date().toISOString();
          req.justificationName = undefined;
          req.justificationDataUrl = undefined;
          req.justificationDriveUrl = undefined;
          req.justificationDriveFileId = undefined;
        } else {
          req.justificationName = undefined;
          req.justificationDataUrl = undefined;
          req.justificationDriveUrl = undefined;
          req.justificationDriveFileId = undefined;
          if (req.status === 'Justificada') {
            req.status = 'Autorizada';
          }
        }

        supabase
          .from('solicitud_licencias')
          .update({
            justificacion_url: null,
            estado: req.status,
            deleted_at: deleteWholeRequest ? req.deletedAt : null,
            detalle_estado: reason,
          })
          .eq('codigo', req.id)
          .then(({ error }) => {
            if (error) console.error('Supabase deleteJustificationFiles error:', error.message);
          });

        const historyEntry: HistorialEstadoSolicitud = {
          id: 'h-' + Date.now() + '-' + count,
          estadoAnterior: prevStatus,
          estadoNuevo: req.status,
          fecha: new Date().toISOString(),
          usuario: superadminEmail,
          detalle: deleteWholeRequest
            ? `Solicitud y comprobante "${fileName}" eliminados por Superadmin. Motivo: ${reason}`
            : `Comprobante adjunto "${fileName}" eliminado por Superadmin. Motivo: ${reason}`,
        };

        if (!req.historialEstados) req.historialEstados = [];
        req.historialEstados.unshift(historyEntry);

        this.auditLogs.unshift({
          id: 'log-' + Date.now() + '-' + count,
          action: 'ELIMINACION_ADJUNTO',
          targetRequestId: req.id,
          employeeNumber: req.employeeNumber,
          agentName: req.agentName,
          reason: `Archivo adjunto "${fileName}" eliminado por ${superadminEmail}. Motivo: ${reason}${
            deleteWholeRequest ? ' (Solicitud eliminada)' : ''
          }`,
          usuario: superadminEmail,
          timestamp: new Date().toISOString(),
        });

        count++;
        affected.push(req);
      }
    }

    if (count > 0) {
      this.notifyListeners();
    }

    return { deletedCount: count, affectedRequests: affected };
  }

  // SISO IMPORT
  public getSisoLicenses(): SisoLicense[] {
    return this.sisoLicenses;
  }

  public getSisoImports(): SisoImportHistory[] {
    return this.sisoImports;
  }

  public getActiveLicensesMap(referenceDate?: string): Map<
    string,
    {
      source: 'Solicitud' | 'SISO';
      licenseType: string;
      dateFrom: string;
      dateTo: string;
      status: string;
    }
  > {
    const today = referenceDate || formatYMD(new Date());
    const map = new Map<
      string,
      {
        source: 'Solicitud' | 'SISO';
        licenseType: string;
        dateFrom: string;
        dateTo: string;
        status: string;
      }
    >();

    for (const r of this.requests) {
      if (['Autorizada', 'Justificada', 'Completada', 'Descuento', 'Pendiente'].includes(r.status)) {
        if (r.dateFrom <= today && r.dateTo >= today) {
          const info = {
            source: r.source,
            licenseType: `${r.licenseTypeCode} - ${r.licenseTypeName}`,
            dateFrom: r.dateFrom,
            dateTo: r.dateTo,
            status: r.status,
          };
          if (r.employeeNumber) map.set(r.employeeNumber.trim().toLowerCase(), info);
          if (r.agentDni) map.set(r.agentDni.replace(/\D/g, ''), info);
        }
      }
    }

    return map;
  }

  public getSisoLicensesByAgent(query: { dni?: string; nroEmpleado?: string }): SisoLicense[] {
    const dniClean = query.dni ? query.dni.replace(/\D/g, '') : '';
    const legajoClean = query.nroEmpleado ? query.nroEmpleado.trim().toLowerCase() : '';
    if (!dniClean && !legajoClean) return [];

    return this.sisoLicenses.filter((s) => {
      const sDni = (s.dni || '').replace(/\D/g, '');
      const sLegajo = ((s.nro_empleado ?? s.nroEmpleado ?? '') + '').trim().toLowerCase();
      return (dniClean && sDni === dniClean) || (legajoClean && sLegajo === legajoClean);
    });
  }

  public async querySisoLicensesByAgent(query: {
    dni?: string;
    nroEmpleado?: string;
  }): Promise<SisoLicense[]> {
    const dniClean = query.dni ? String(query.dni).replace(/\D/g, '') : '';
    const legajoClean = query.nroEmpleado ? String(query.nroEmpleado).trim() : '';
    if (!dniClean && !legajoClean) return [];

    try {
      let q = supabase.from('siso_licencias').select('*');
      if (dniClean && legajoClean) {
        q = q.or(`dni.eq.${dniClean},nro_empleado.eq.${legajoClean}`);
      } else if (dniClean) {
        q = q.eq('dni', dniClean);
      } else {
        q = q.eq('nro_empleado', legajoClean);
      }

      const { data: dbSiso, error } = await q.order('fecha_desde', { ascending: false });
      if (!error && dbSiso) {
        return dbSiso.map((s: any): SisoLicense => ({
          id: s.id,
          siso_id: s.siso_id,
          nro_empleado: s.nro_empleado,
          nroEmpleado: s.nro_empleado,
          dni: s.dni,
          nombre: s.nombre,
          email: s.email,
          tipo: s.tipo,
          carga: s.carga,
          fecha_desde: s.fecha_desde,
          fecha_hasta: s.fecha_hasta,
          desde: s.fecha_desde,
          hasta: s.fecha_hasta,
          dias: s.dias,
          justifica: s.justifica,
          cod_licencia: s.cod_licencia ? String(s.cod_licencia) : '',
          codLicencia: s.cod_licencia ? String(s.cod_licencia) : '',
          fecha_alta: s.fecha_alta,
          fechaAlta: s.fecha_alta,
          auditor: s.auditor,
          patologia: s.patologia,
          fecha_auditoria: s.fecha_auditoria,
          fechaAuditoria: s.fecha_auditoria,
          medico_interviniente: s.medico_interviniente,
          medicoInterviniente: s.medico_interviniente,
          matricula_medico_interviniente: s.matricula_medico_interviniente,
          matriculaMedicoInterviniente: s.matricula_medico_interviniente,
          establecimientos_o_sector: s.establecimientos_o_sector,
          establecimientosOSector: s.establecimientos_o_sector,
          fechaImportacion: s.created_at || new Date().toISOString(),
          importId: 'import-supabase',
        }));
      }
    } catch (e) {
      console.warn('Error querying SISO from Supabase:', e);
    }

    return this.getSisoLicensesByAgent(query);
  }

  public analyzeSisoCsv(csvText: string): {
    valid: boolean;
    detected: number;
    newCount: number;
    updateCount: number;
    errors: string[];
    warnings: string[];
    delimiter: string;
    previewRows: Array<{
      id: string;
      nombre: string;
      nroEmpleado: string;
      dni: string;
      tipo: string;
      desde: string;
      hasta: string;
      dias: number;
      justifica: string;
      codLicencia: string;
      isExisting: boolean;
    }>;
  } {
    const { headers, dataRows, delimiter, isHeaderAutoAssigned } = preprocessSisoCsv(csvText);

    if (dataRows.length === 0) {
      return {
        valid: false,
        detected: 0,
        newCount: 0,
        updateCount: 0,
        errors: ['El archivo o texto no posee registros de datos suficientes para procesar.'],
        warnings: [],
        delimiter: ';',
        previewRows: [],
      };
    }

    const errors: string[] = [];
    const warnings: string[] = [];

    if (!isHeaderAutoAssigned) {
      const requiredConcepts = [
        { label: 'ID', keys: ['ID', 'NRO TRAMITE', 'ID SISO'] },
        { label: 'NRO EMPLEADO', keys: ['NRO EMPLEADO', 'LEGAJO', 'EMPLEADO'] },
        { label: 'DESDE', keys: ['DESDE', 'FECHA DESDE', 'INICIO'] },
        { label: 'HASTA', keys: ['HASTA', 'FECHA HASTA', 'FIN'] },
      ];

      const missing = requiredConcepts.filter(
        (req) => !headers.some((h) => req.keys.some((k) => cleanHeaderKey(k) === h || h.includes(cleanHeaderKey(k))))
      );

      if (missing.length > 0) {
        errors.push(`Columnas requeridas faltantes en el reporte SISO: ${missing.map((m) => m.label).join(', ')}`);
        return {
          valid: false,
          detected: 0,
          newCount: 0,
          updateCount: 0,
          errors,
          warnings,
          delimiter,
          previewRows: [],
        };
      }
    }

    let detected = 0;
    let newCount = 0;
    let updateCount = 0;
    const previewRows: Array<{
      id: string;
      nombre: string;
      nroEmpleado: string;
      dni: string;
      tipo: string;
      desde: string;
      hasta: string;
      dias: number;
      justifica: string;
      codLicencia: string;
      isExisting: boolean;
    }> = [];

    for (let i = 0; i < dataRows.length; i++) {
      const line = dataRows[i];
      if (!line.trim()) continue;

      const values = parseCSVLine(line, delimiter);
      const row: Record<string, string> = {};
      headers.forEach((h, idx) => {
        row[h] = values[idx] !== undefined ? values[idx] : '';
      });

      const sisoId = getField(row, 'ID', 'ID SISO', 'NRO TRAMITE') || `siso-gen-${i + 1}`;
      const nroEmpleado = getField(row, 'NRO EMPLEADO', 'LEGAJO', 'EMPLEADO');
      const dni = getField(row, 'DNI', 'DOCUMENTO').replace(/\D/g, '');
      const nombre = getField(row, 'NOMBRE', 'APELLIDO Y NOMBRE', 'NOMBRE Y APELLIDO', 'AGENTE') || 'Sin Nombre';
      const rawDesde = getField(row, 'DESDE', 'FECHA DESDE', 'INICIO');
      const rawHasta = getField(row, 'HASTA', 'FECHA HASTA', 'FIN');
      const desde = normalizeSisoDate(rawDesde);
      const hasta = normalizeSisoDate(rawHasta);

      if (!sisoId || !desde || !hasta) {
        warnings.push(`Fila ${i + 1}: Datos incompletos (requiere ID, DESDE, HASTA).`);
        continue;
      }

      detected++;

      const rawDias = getField(row, 'DIAS', 'CANTIDAD DIAS', 'DIAS TOTALES');
      const diasParsed = parseInt(rawDias, 10);
      const dias = !isNaN(diasParsed) && diasParsed > 0 ? diasParsed : calculateDaysBetween(desde, hasta);

      const justifica = getField(row, 'JUSTIFICA', 'ESTADO', 'JUSTIFICADO', 'AUDITORIA') || 'SIN AUDITAR';
      const codLicencia =
        getField(row, 'COD LICENCIA', 'CODIGO LICENCIA', 'CODIGO', 'ARTICULO') ||
        '7000 - PENDIENTE DE AUDITAR MEDICINA LABORAL';
      const tipo = getField(row, 'TIPO', 'TIPO LICENCIA') || 'ENFERMEDAD';

      const isExisting = this.sisoLicenses.some(
        (lic) => lic.id === sisoId || (lic.nroEmpleado === nroEmpleado && lic.desde === desde && lic.hasta === hasta)
      );

      if (isExisting) {
        updateCount++;
      } else {
        newCount++;
      }

      if (previewRows.length < 15) {
        previewRows.push({
          id: sisoId,
          nombre,
          nroEmpleado,
          dni,
          tipo,
          desde,
          hasta,
          dias,
          justifica,
          codLicencia,
          isExisting,
        });
      }
    }

    return {
      valid: errors.length === 0 && detected > 0,
      detected,
      newCount,
      updateCount,
      errors,
      warnings,
      delimiter,
      previewRows,
    };
  }

  public async importSisoCsv(
    csvText: string,
    fileName: string,
    usuarioEmail: string
  ): Promise<{
    success: boolean;
    detected: number;
    created: number;
    updated: number;
    errors: string[];
    importId: string;
  }> {
    const { headers, dataRows, delimiter } = preprocessSisoCsv(csvText);

    if (dataRows.length === 0) {
      return {
        success: false,
        detected: 0,
        created: 0,
        updated: 0,
        errors: ['El archivo CSV está vacío o no contiene filas de datos.'],
        importId: '',
      };
    }

    const importId = 'imp-' + Date.now();
    const errors: string[] = [];
    let created = 0;
    const updated = 0;
    let detected = 0;
    const newSisoItemsToInsert: SisoLicense[] = [];

    for (let i = 0; i < dataRows.length; i++) {
      const line = dataRows[i];
      if (!line.trim()) continue;

      const values = parseCSVLine(line, delimiter);
      const row: Record<string, string> = {};
      headers.forEach((h, idx) => {
        row[h] = values[idx] !== undefined ? values[idx] : '';
      });

      const sisoId = getField(row, 'ID', 'ID SISO', 'NRO TRAMITE') || `siso-gen-${Date.now()}-${i}`;
      const nroEmpleado = getField(row, 'NRO EMPLEADO', 'LEGAJO', 'EMPLEADO');
      const dni = getField(row, 'DNI', 'DOCUMENTO').replace(/\D/g, '');
      const nombre = getField(row, 'NOMBRE', 'APELLIDO Y NOMBRE', 'NOMBRE Y APELLIDO', 'AGENTE') || 'Sin Nombre';
      const email = getField(row, 'EMAIL', 'CORREO', 'MAIL');
      const tipo = getField(row, 'TIPO', 'TIPO LICENCIA') || 'ENFERMEDAD';
      const rawCarga = getField(row, 'CARGA', 'FECHA CARGA');
      const rawDesde = getField(row, 'DESDE', 'FECHA DESDE', 'INICIO');
      const rawHasta = getField(row, 'HASTA', 'FECHA HASTA', 'FIN');
      const desde = normalizeSisoDate(rawDesde);
      const hasta = normalizeSisoDate(rawHasta);

      if (!sisoId || !desde || !hasta) {
        errors.push(`Fila ${i + 1}: Datos incompletos (requiere ID, DESDE, HASTA).`);
        continue;
      }

      detected++;

      const rawDias = getField(row, 'DIAS', 'CANTIDAD DIAS', 'DIAS TOTALES');
      const diasParsed = parseInt(rawDias, 10);
      const dias = !isNaN(diasParsed) && diasParsed > 0 ? diasParsed : calculateDaysBetween(desde, hasta);

      const justifica = getField(row, 'JUSTIFICA', 'ESTADO', 'JUSTIFICADO', 'AUDITORIA') || 'SIN AUDITAR';
      const codLicencia =
        getField(row, 'COD LICENCIA', 'CODIGO LICENCIA', 'CODIGO', 'ARTICULO') ||
        '7000 - PENDIENTE DE AUDITAR MEDICINA LABORAL';
      const rawFechaAlta = getField(row, 'FECHA ALTA', 'ALTA');
      const auditor = getField(row, 'AUDITOR', 'MEDICO AUDITOR');
      const patologia = getField(row, 'PATOLOGIA', 'DIAGNOSTICO', 'CIE10');
      const rawFechaAuditoria = getField(row, 'FECHA AUDITORIA');
      const medicoInterviniente = getField(row, 'MEDICO_INTERVINIENTE', 'MEDICO INTERVINIENTE', 'MEDICO');
      const matriculaMedicoInterviniente = getField(
        row,
        'MATRICULA_MEDICO_INTERVINIENTE',
        'MATRICULA MEDICO INTERVINIENTE',
        'MATRICULA'
      );
      const establecimientosOSector =
        getField(row, 'ESTABLECIMIENTOS O SECTOR', 'ESTABLECIMIENTO', 'SECTOR') || 'CPEM N° 25';

      const existingIdx = this.sisoLicenses.findIndex(
        (lic) => lic.id === sisoId || (lic.siso_id && String(lic.siso_id) === String(sisoId))
      );

      if (existingIdx !== -1) {
        continue;
      }

      const sisoItem: SisoLicense = {
        siso_id: !isNaN(Number(sisoId)) ? Number(sisoId) : sisoId,
        id: sisoId,
        nro_empleado: nroEmpleado,
        nroEmpleado,
        dni,
        nombre,
        email,
        tipo,
        carga: rawCarga,
        fecha_desde: rawDesde,
        fecha_hasta: rawHasta,
        desde: rawDesde,
        hasta: rawHasta,
        dias: rawDias || String(dias),
        justifica,
        cod_licencia: codLicencia,
        codLicencia,
        fecha_alta: rawFechaAlta,
        fechaAlta: rawFechaAlta,
        auditor,
        patologia,
        fecha_auditoria: rawFechaAuditoria,
        fechaAuditoria: rawFechaAuditoria,
        medico_interviniente: medicoInterviniente,
        medicoInterviniente,
        matricula_medico_interviniente: matriculaMedicoInterviniente,
        matriculaMedicoInterviniente,
        establecimientos_o_sector: establecimientosOSector,
        establecimientosOSector,
        fechaImportacion: new Date().toISOString(),
        importId,
      };

      this.sisoLicenses.unshift(sisoItem);
      created++;
      newSisoItemsToInsert.push(sisoItem);
    }

    if (newSisoItemsToInsert.length > 0) {
      const dbRows = newSisoItemsToInsert.map((s) => {
        const parsedCod = s.cod_licencia ? parseInt(String(s.cod_licencia), 10) : NaN;
        return {
          id: s.id,
          nro_empleado: s.nro_empleado,
          dni: s.dni,
          nombre: s.nombre,
          email: s.email,
          tipo: s.tipo,
          carga: s.carga,
          fecha_desde: s.fecha_desde,
          fecha_hasta: s.fecha_hasta,
          dias: s.dias,
          justifica: s.justifica,
          cod_licencia: !isNaN(parsedCod) ? parsedCod : null,
          fecha_alta: s.fecha_alta,
          auditor: s.auditor,
          patologia: s.patologia,
          fecha_auditoria: s.fecha_auditoria,
          medico_interviniente: s.medico_interviniente,
          matricula_medico_interviniente: s.matricula_medico_interviniente,
          establecimientos_o_sector: s.establecimientos_o_sector,
        };
      });

      for (let idx = 0; idx < dbRows.length; idx += 200) {
        const chunk = dbRows.slice(idx, idx + 200);
        const { error: insErr } = await supabase.from('siso_licencias').insert(chunk);
        if (insErr) {
          errors.push(`Error insertando lote SISO en Supabase: ${insErr.message}`);
        }
      }
    }

    const importRecord: SisoImportHistory = {
      id: importId,
      fecha: new Date().toISOString(),
      nombreArchivo: fileName,
      cantidadDetectados: detected,
      registrosNuevos: created,
      registrosActualizados: updated,
      usuario: usuarioEmail,
      errores: errors,
    };

    this.sisoImports.unshift(importRecord);

    this.auditLogs.unshift({
      id: 'log-' + Date.now(),
      action: 'IMPORTACION_SISO',
      reason: `Importación CSV "${fileName}": ${created} nuevos, ${updated} actualizados de ${detected} detectados.`,
      usuario: usuarioEmail,
      timestamp: new Date().toISOString(),
    });

    this.notifyListeners();

    return {
      success: errors.length === 0,
      detected,
      created,
      updated,
      errors,
      importId,
    };
  }

  // LICENSE TYPES CONFIG
  public getLicenseTypes(): Promise<LicenseType[]> {
    return Promise.resolve(this.licenseTypes.filter((lt) => lt.active !== false));
  }

  public getAllLicenseTypes(): LicenseType[] {
    return this.licenseTypes;
  }

  public async updateLicenseType(id: string, updates: Partial<LicenseType>): Promise<LicenseType> {
    const index = this.licenseTypes.findIndex((lt) => lt.id === id);
    if (index === -1) throw new Error('Tipo de licencia no encontrado.');

    const current = this.licenseTypes[index];
    const numId = current.tipo_licencia_id || parseInt(id.replace(/\D/g, ''), 10);

    const sbUpdates: Record<string, any> = {};
    if (updates.code !== undefined) sbUpdates.codigo = updates.code.trim().slice(0, 20);
    if (updates.name !== undefined) sbUpdates.nombre = updates.name.trim().slice(0, 150);
    if (updates.category !== undefined) sbUpdates.categoria = String(updates.category).slice(0, 50);
    if (updates.sinLimite !== undefined) sbUpdates.sin_limite = updates.sinLimite;
    if (updates.maxDaysPerYear !== undefined || updates.diasTotales !== undefined) {
      sbUpdates.max_dias_anio = updates.maxDaysPerYear ?? updates.diasTotales ?? null;
    }
    if (updates.maxConsecutiveDays !== undefined || updates.diasMensuales !== undefined) {
      sbUpdates.max_dias_seguidos = updates.maxConsecutiveDays ?? updates.diasMensuales ?? null;
    }
    if (updates.requiresJustification !== undefined) {
      sbUpdates.requiere_justificacion = updates.requiresJustification;
    }
    if (updates.requiresObligations !== undefined) {
      sbUpdates.requiere_obligaciones = updates.requiresObligations;
    }
    if (updates.description !== undefined) sbUpdates.descripccion = updates.description;
    if (updates.active !== undefined) sbUpdates.activo = updates.active;

    if (numId && !isNaN(numId) && Object.keys(sbUpdates).length > 0) {
      const { data: updatedRow, error } = await supabase
        .from('tipos_licencias')
        .update(sbUpdates)
        .eq('tipo_licencia_id', numId)
        .select()
        .single();

      if (error) {
        throw new Error(`Error al actualizar tipo de licencia en Supabase: ${error.message}`);
      }
      if (updatedRow) {
        this.licenseTypes[index] = this.mapDbLicenseType(updatedRow);
        this.notifyListeners();
        return this.licenseTypes[index];
      }
    }

    this.licenseTypes[index] = {
      ...current,
      ...updates,
    };
    this.notifyListeners();
    return this.licenseTypes[index];
  }

  public async createLicenseType(data: Omit<LicenseType, 'id'>): Promise<LicenseType> {
    const { data: insRow, error } = await this.insertWithIdentityFallback(
      'tipos_licencias',
      'tipo_licencia_id',
      {
        codigo: data.code.trim().slice(0, 20),
        nombre: data.name.trim().slice(0, 150),
        categoria: String(data.category || 'Corta duración').slice(0, 50),
        sin_limite: Boolean(data.sinLimite),
        max_dias_anio: data.maxDaysPerYear ?? data.diasTotales ?? null,
        max_dias_seguidos: data.maxConsecutiveDays ?? data.diasMensuales ?? null,
        requiere_justificacion: Boolean(data.requiresJustification),
        requiere_obligaciones: data.requiresObligations !== false,
        descripccion: data.description || '',
        activo: data.active !== false,
      }
    );

    if (error || !insRow) {
      throw new Error(error?.message || 'Error al crear tipo de licencia en Supabase.');
    }

    const newType = this.mapDbLicenseType(insRow);
    this.licenseTypes.push(newType);
    this.notifyListeners();
    return newType;
  }

  public async importLicenseTypesFromCSV(
    csvText: string
  ): Promise<{ total: number; added: number; updated: number }> {
    const lines = csvText.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) throw new Error('El archivo CSV no contiene filas de datos.');

    let added = 0;
    let updated = 0;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const parts: string[] = [];
      let cur = '';
      let inQ = false;
      for (const c of line) {
        if (c === '"') inQ = !inQ;
        else if (c === ',' && !inQ) {
          parts.push(cur.trim());
          cur = '';
        } else {
          cur += c;
        }
      }
      parts.push(cur.trim());
      if (parts.length < 4) continue;

      const [licencia, dias_totales_str, tipo_dias, activa_str, dias_mensuales_str] = parts;
      const dias_totales = parseInt(dias_totales_str, 10) || 1;
      const dias_mensuales = parseInt(dias_mensuales_str || dias_totales_str, 10) || dias_totales;
      const activa = activa_str ? activa_str.toUpperCase() === 'SI' : true;
      const tipoDiasNorm: 'habiles' | 'continuos' =
        tipo_dias && tipo_dias.toLowerCase().includes('contin') ? 'continuos' : 'habiles';

      const existing = this.licenseTypes.find(
        (lt) => lt.name.trim().toLowerCase() === licencia.trim().toLowerCase()
      );

      const desc = `Régimen: ${dias_totales} días ${tipoDiasNorm} anuales (máx. ${dias_mensuales} días por mes).`;

      if (existing?.tipo_licencia_id) {
        await supabase
          .from('tipos_licencias')
          .update({
            nombre: licencia.trim().slice(0, 150),
            max_dias_anio: dias_totales,
            max_dias_seguidos: dias_mensuales,
            activo: activa,
            descripccion: desc,
          })
          .eq('tipo_licencia_id', existing.tipo_licencia_id);
        updated++;
      } else {
        const code = 'LIC-' + (this.licenseTypes.length + added + 1);
        await this.insertWithIdentityFallback('tipos_licencias', 'tipo_licencia_id', {
          codigo: code,
          nombre: licencia.trim().slice(0, 150),
          categoria: dias_totales >= 30 ? 'Larga duración' : 'Corta duración',
          sin_limite: dias_totales >= 365,
          max_dias_anio: dias_totales,
          max_dias_seguidos: dias_mensuales,
          requiere_justificacion: true,
          requiere_obligaciones: dias_totales > 5,
          descripccion: desc,
          activo: activa,
        });
        added++;
      }
    }

    await this.refreshFromSupabase();
    return { total: lines.length - 1, added, updated };
  }

  public async resetLicenseTypesToCSVDefault(): Promise<LicenseType[]> {
    await this.refreshFromSupabase();
    return this.licenseTypes;
  }

  // WEEKLY ABSENCES & LONG LICENSES
  public getWeeklyAbsences(monday: Date): WeeklyAbsenceRow[] {
    const mondayStr = formatYMD(monday);
    const friDate = new Date(monday);
    friDate.setDate(monday.getDate() + 4);
    const fridayStr = formatYMD(friDate);

    const weekDays: { dateStr: string; key: 'lun' | 'mar' | 'mie' | 'jue' | 'vie' }[] = [
      { dateStr: formatYMD(monday), key: 'lun' },
      { dateStr: formatYMD(new Date(monday.getTime() + 86400000 * 1)), key: 'mar' },
      { dateStr: formatYMD(new Date(monday.getTime() + 86400000 * 2)), key: 'mie' },
      { dateStr: formatYMD(new Date(monday.getTime() + 86400000 * 3)), key: 'jue' },
      { dateStr: formatYMD(new Date(monday.getTime() + 86400000 * 4)), key: 'vie' },
    ];

    const effectiveStatuses: LicenseStatus[] = ['Autorizada', 'Justificada', 'Completada', 'Descuento'];

    const activeRequests = this.requests.filter((r) => {
      if (!effectiveStatuses.includes(r.status)) return false;
      return !(r.dateTo < mondayStr || r.dateFrom > fridayStr);
    });

    const rows: WeeklyAbsenceRow[] = [];
    const seenKeys = new Set<string>();

    for (const r of activeRequests) {
      const dedupKey = `${r.employeeNumber}_${r.dateFrom}_${r.dateTo}`;
      if (seenKeys.has(dedupKey)) continue;
      seenKeys.add(dedupKey);

      const days = { lun: false, mar: false, mie: false, jue: false, vie: false };
      for (const wDay of weekDays) {
        if (wDay.dateStr >= r.dateFrom && wDay.dateStr <= r.dateTo) {
          days[wDay.key] = true;
        }
      }

      rows.push({
        uniqueKey: r.id,
        agentName: r.agentName,
        employeeNumber: r.employeeNumber,
        cargoCursoSiso: r.postDescription,
        source: r.source,
        licenseType: `${r.licenseTypeCode} - ${r.licenseTypeName}`,
        dateFrom: r.dateFrom,
        dateTo: r.dateTo,
        status: r.status,
        days,
      });
    }

    return rows.sort((a, b) => a.agentName.localeCompare(b.agentName));
  }

  public getLongLicenses(): LongLicenseItem[] {
    const items: LongLicenseItem[] = [];

    for (const r of this.requests) {
      if (r.status === 'Eliminada' || r.status === 'Rechazada') continue;
      const totalDays = calculateDaysBetween(r.dateFrom, r.dateTo);
      if (totalDays > 15) {
        let cargo = r.postDescription;
        let curso = 'Institucional';
        if (r.postDescription.includes('-')) {
          const parts = r.postDescription.split('-');
          cargo = parts[0].trim();
          curso = parts.slice(1).join('-').trim();
        }

        items.push({
          id: r.id,
          agentName: r.agentName,
          employeeNumber: r.employeeNumber,
          cargo,
          curso,
          licenseType: `${r.licenseTypeCode} - ${r.licenseTypeName}`,
          dateFrom: r.dateFrom,
          dateTo: r.dateTo,
          totalDays,
          source: r.source,
          status: r.status,
        });
      }
    }

    return items;
  }

  public getDashboardMetrics() {
    const today = formatYMD(new Date());
    const agents = this.getAgents();
    const activeAgents = agents.filter((a) => a.activo).length;
    const activeCargos = this.cargos.filter((c) => c.activo).length;
    const pendingRequests = this.requests.filter((r) => r.status === 'Pendiente').length;
    const activeLicensesToday = this.requests.filter(
      (r) =>
        ['Autorizada', 'Justificada', 'Completada', 'Descuento'].includes(r.status) &&
        r.dateFrom <= today &&
        r.dateTo >= today
    ).length;
    const longLicensesCount = this.getLongLicenses().length;

    return {
      activeAgents,
      activeCargos,
      pendingRequests,
      activeLicensesToday,
      longLicensesCount,
      totalSisoLicenses: this.sisoLicenses.length,
      totalRequests: this.requests.length,
    };
  }
}

export const dataService = new DataService();
