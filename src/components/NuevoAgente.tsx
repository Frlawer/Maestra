import React, { useState, useEffect } from 'react';
import {
  UserPlus,
  CheckCircle2,
  AlertCircle,
  ArrowLeft,
  FileEdit,
  Phone,
  Mail,
  Calendar,
  MapPin,
  Home,
  GraduationCap,
  IdCard,
  Hash,
} from 'lucide-react';
import { Agent } from '../types';
import { dataService } from '../services/dataService';

interface NuevoAgenteProps {
  initialQuery?: string;
  onGoToSolicitar: (employeeNumber?: string) => void;
}

const buildInitialForm = (query?: string) => {
  const digits = (query || '').replace(/\D/g, '');
  const looksLikeDni = digits.length >= 7;
  return {
    apellidos: '',
    nombres: '',
    employeeNumber: !looksLikeDni && digits ? digits : '',
    dni: looksLikeDni ? digits : '',
    telefono: '',
    email: '',
    fechaNacimiento: '',
    lugarNacimiento: '',
    domicilio: '',
    titulo: '',
  };
};

export const NuevoAgente: React.FC<NuevoAgenteProps> = ({
  initialQuery = '',
  onGoToSolicitar,
}) => {
  const [formData, setFormData] = useState(() => buildInitialForm(initialQuery));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [createdAgent, setCreatedAgent] = useState<Agent | null>(null);

  useEffect(() => {
    if (initialQuery && !createdAgent) {
      setFormData((prev) => {
        const pre = buildInitialForm(initialQuery);
        return {
          ...prev,
          dni: prev.dni || pre.dni,
          employeeNumber: prev.employeeNumber || pre.employeeNumber,
        };
      });
    }
  }, [initialQuery, createdAgent]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!formData.apellidos.trim() || !formData.nombres.trim()) {
      setErrorMessage('Los campos Apellidos y Nombres son obligatorios.');
      return;
    }

    const cleanDni = formData.dni.replace(/\D/g, '');
    if (!cleanDni || cleanDni.length < 6) {
      setErrorMessage('Ingrese un DNI numérico válido (sin puntos).');
      return;
    }

    const cleanLegajo = formData.employeeNumber.replace(/\D/g, '');
    if (!cleanLegajo) {
      setErrorMessage('El Número de empleado / Legajo es obligatorio y debe ser numérico.');
      return;
    }

    if (!formData.telefono.trim()) {
      setErrorMessage('El Teléfono de contacto es obligatorio.');
      return;
    }

    const emailTrimmed = formData.email.trim();
    if (!emailTrimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTrimmed)) {
      setErrorMessage('Ingrese un correo electrónico válido.');
      return;
    }

    setIsSubmitting(true);
    try {
      const saved = await dataService.createAgent({
        apellidos: formData.apellidos.trim(),
        nombres: formData.nombres.trim(),
        employeeNumber: cleanLegajo,
        dni: cleanDni,
        telefono: formData.telefono.trim().slice(0, 20),
        email: emailTrimmed.toLowerCase(),
        fechaNacimiento: formData.fechaNacimiento.trim(),
        lugarNacimiento: formData.lugarNacimiento.trim(),
        domicilio: formData.domicilio.trim(),
        titulo: formData.titulo.trim(),
        activo: true,
      });

      setCreatedAgent(saved);
    } catch (err: any) {
      setErrorMessage(err?.message || 'No se pudo registrar el agente. Intente nuevamente.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleResetForm = () => {
    setCreatedAgent(null);
    setErrorMessage(null);
    setFormData(buildInitialForm(''));
  };

  if (createdAgent) {
    return (
      <div className="max-w-xl mx-auto px-4 py-8 animate-fade-in">
        <div className="bg-white rounded-2xl shadow-xl border border-emerald-100 p-6 sm:p-8 text-center space-y-6">
          <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto text-emerald-600 shadow-sm">
            <CheckCircle2 className="w-10 h-10" />
          </div>

          <div className="space-y-2">
            <span className="inline-block px-3 py-1 bg-emerald-100 text-emerald-800 text-xs font-semibold rounded-full uppercase tracking-wider">
              Alta Registrada
            </span>
            <h2 className="text-2xl font-bold text-slate-800">
              ¡Agente registrado con éxito!
            </h2>
            <p className="text-sm text-slate-600">
              Sus datos fueron guardados en el padrón institucional del CPEM Nº 25. Si aún no tiene cargos asignados, Secretaría deberá vincularlos antes de poder solicitar una licencia.
            </p>
          </div>

          <div className="bg-slate-50 rounded-xl p-4 text-left text-xs sm:text-sm space-y-2.5 border border-slate-200">
            <div className="flex justify-between border-b border-slate-200/60 pb-2">
              <span className="text-slate-500 font-medium">Agente:</span>
              <span className="font-bold text-slate-800">{createdAgent.fullName}</span>
            </div>
            <div className="flex justify-between border-b border-slate-200/60 pb-2">
              <span className="text-slate-500 font-medium">DNI:</span>
              <span className="font-mono font-semibold text-slate-800">{createdAgent.dni}</span>
            </div>
            <div className="flex justify-between border-b border-slate-200/60 pb-2">
              <span className="text-slate-500 font-medium">Legajo / N° Empleado:</span>
              <span className="font-mono font-semibold text-slate-800">{createdAgent.employeeNumber}</span>
            </div>
            <div className="flex justify-between border-b border-slate-200/60 pb-2">
              <span className="text-slate-500 font-medium">Teléfono:</span>
              <span className="font-medium text-slate-800">{createdAgent.telefono}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500 font-medium">Email:</span>
              <span className="font-medium text-slate-800 truncate max-w-[60%]">{createdAgent.email}</span>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-3 pt-2">
            <button
              type="button"
              onClick={() => onGoToSolicitar(createdAgent.dni || createdAgent.employeeNumber)}
              className="flex-1 inline-flex items-center justify-center gap-2 py-3 px-4 rounded-xl bg-[#2B3E4C] hover:bg-[#1E2C36] text-white font-semibold text-sm shadow-md transition-colors cursor-pointer"
            >
              <FileEdit className="w-4 h-4 text-[#87b867]" />
              <span>Ir a Solicitar licencia</span>
            </button>
            <button
              type="button"
              onClick={handleResetForm}
              className="py-3 px-4 rounded-xl border border-slate-300 hover:bg-slate-50 text-slate-700 font-medium text-sm transition-colors cursor-pointer"
            >
              Registrar otro agente
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 sm:py-8 space-y-6 animate-fade-in">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5 sm:p-7 space-y-6">
        {/* Encabezado */}
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 pb-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#87b867]/15 text-[#2B3E4C] flex items-center justify-center shrink-0 border border-[#87b867]/30">
              <UserPlus className="w-5 h-5 text-[#2B3E4C]" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-bold text-slate-800">
                Alta de Nuevo Agente
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Complete sus datos personales y de contacto para incorporarse al padrón de la institución.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => onGoToSolicitar()}
            className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-[#2B3E4C] transition-colors shrink-0 cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Volver</span>
          </button>
        </div>

        {errorMessage && (
          <div className="p-3.5 bg-red-50 border border-red-200 text-red-700 text-xs sm:text-sm rounded-xl flex items-start gap-2.5">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-500" />
            <span>{errorMessage}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4 text-xs sm:text-sm">
          {/* Apellidos y Nombres */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="nuevoAgenteApellidos" className="block font-semibold text-slate-700 mb-1">
                Apellidos <span className="text-red-500">*</span>
              </label>
              <input
                id="nuevoAgenteApellidos"
                type="text"
                required
                placeholder="Ej: González"
                value={formData.apellidos}
                onChange={(e) => setFormData({ ...formData, apellidos: e.target.value })}
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 focus:border-blue-500 focus:ring-4 focus:ring-blue-100 transition-all"
              />
            </div>

            <div>
              <label htmlFor="nuevoAgenteNombres" className="block font-semibold text-slate-700 mb-1">
                Nombres <span className="text-red-500">*</span>
              </label>
              <input
                id="nuevoAgenteNombres"
                type="text"
                required
                placeholder="Ej: Martín Alberto"
                value={formData.nombres}
                onChange={(e) => setFormData({ ...formData, nombres: e.target.value })}
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 focus:border-blue-500 focus:ring-4 focus:ring-blue-100 transition-all"
              />
            </div>
          </div>

          {/* DNI y Legajo */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="nuevoAgenteDni" className="block font-semibold text-slate-700 mb-1">
                DNI (sin puntos) <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <input
                  id="nuevoAgenteDni"
                  type="text"
                  inputMode="numeric"
                  required
                  placeholder="Ej: 28475912"
                  value={formData.dni}
                  onChange={(e) => setFormData({ ...formData, dni: e.target.value.replace(/[^\d]/g, '') })}
                  className="w-full pl-9 pr-3.5 py-2.5 rounded-xl border border-slate-300 focus:border-blue-500 focus:ring-4 focus:ring-blue-100 font-mono transition-all"
                />
                <IdCard className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
              </div>
            </div>

            <div>
              <label htmlFor="nuevoAgenteLegajo" className="block font-semibold text-slate-700 mb-1">
                Número de empleado / Legajo <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <input
                  id="nuevoAgenteLegajo"
                  type="text"
                  inputMode="numeric"
                  required
                  placeholder="Ej: 1042"
                  value={formData.employeeNumber}
                  onChange={(e) => setFormData({ ...formData, employeeNumber: e.target.value.replace(/[^\d]/g, '') })}
                  className="w-full pl-9 pr-3.5 py-2.5 rounded-xl border border-slate-300 focus:border-blue-500 focus:ring-4 focus:ring-blue-100 font-mono transition-all"
                />
                <Hash className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
              </div>
            </div>
          </div>

          {/* Teléfono y Email */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="nuevoAgenteTelefono" className="block font-semibold text-slate-700 mb-1">
                Teléfono <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <input
                  id="nuevoAgenteTelefono"
                  type="tel"
                  required
                  maxLength={20}
                  placeholder="Ej: 299-4552190"
                  value={formData.telefono}
                  onChange={(e) => setFormData({ ...formData, telefono: e.target.value })}
                  className="w-full pl-9 pr-3.5 py-2.5 rounded-xl border border-slate-300 focus:border-blue-500 focus:ring-4 focus:ring-blue-100 transition-all"
                />
                <Phone className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
              </div>
            </div>

            <div>
              <label htmlFor="nuevoAgenteEmail" className="block font-semibold text-slate-700 mb-1">
                Correo electrónico <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <input
                  id="nuevoAgenteEmail"
                  type="email"
                  required
                  placeholder="agente@neuquen.edu.ar"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className="w-full pl-9 pr-3.5 py-2.5 rounded-xl border border-slate-300 focus:border-blue-500 focus:ring-4 focus:ring-blue-100 transition-all"
                />
                <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
              </div>
            </div>
          </div>

          {/* Fecha y Lugar de Nacimiento (Opcionales) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="nuevoAgenteFechaNac" className="block font-semibold text-slate-700 mb-1">
                Fecha de nacimiento <span className="text-slate-400 font-normal">(Opcional)</span>
              </label>
              <div className="relative">
                <input
                  id="nuevoAgenteFechaNac"
                  type="date"
                  value={formData.fechaNacimiento}
                  onChange={(e) => setFormData({ ...formData, fechaNacimiento: e.target.value })}
                  className="w-full pl-9 pr-3.5 py-2.5 rounded-xl border border-slate-300 focus:border-blue-500 focus:ring-4 focus:ring-blue-100 font-mono transition-all"
                />
                <Calendar className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
              </div>
            </div>

            <div>
              <label htmlFor="nuevoAgenteLugarNac" className="block font-semibold text-slate-700 mb-1">
                Lugar de nacimiento <span className="text-slate-400 font-normal">(Opcional)</span>
              </label>
              <div className="relative">
                <input
                  id="nuevoAgenteLugarNac"
                  type="text"
                  placeholder="Ciudad, Provincia"
                  value={formData.lugarNacimiento}
                  onChange={(e) => setFormData({ ...formData, lugarNacimiento: e.target.value })}
                  className="w-full pl-9 pr-3.5 py-2.5 rounded-xl border border-slate-300 focus:border-blue-500 focus:ring-4 focus:ring-blue-100 transition-all"
                />
                <MapPin className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
              </div>
            </div>
          </div>

          {/* Domicilio y Título (Opcionales) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="nuevoAgenteDomicilio" className="block font-semibold text-slate-700 mb-1">
                Domicilio <span className="text-slate-400 font-normal">(Opcional)</span>
              </label>
              <div className="relative">
                <input
                  id="nuevoAgenteDomicilio"
                  type="text"
                  placeholder="Calle, número, localidad"
                  value={formData.domicilio}
                  onChange={(e) => setFormData({ ...formData, domicilio: e.target.value })}
                  className="w-full pl-9 pr-3.5 py-2.5 rounded-xl border border-slate-300 focus:border-blue-500 focus:ring-4 focus:ring-blue-100 transition-all"
                />
                <Home className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
              </div>
            </div>

            <div>
              <label htmlFor="nuevoAgenteTitulo" className="block font-semibold text-slate-700 mb-1">
                Título docente / habilitante <span className="text-slate-400 font-normal">(Opcional)</span>
              </label>
              <div className="relative">
                <input
                  id="nuevoAgenteTitulo"
                  type="text"
                  placeholder="Ej: Profesor en..."
                  value={formData.titulo}
                  onChange={(e) => setFormData({ ...formData, titulo: e.target.value })}
                  className="w-full pl-9 pr-3.5 py-2.5 rounded-xl border border-slate-300 focus:border-blue-500 focus:ring-4 focus:ring-blue-100 transition-all"
                />
                <GraduationCap className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
              </div>
            </div>
          </div>

          {/* Submit */}
          <div className="pt-3 border-t border-slate-100 flex flex-col sm:flex-row gap-3">
            <button
              type="button"
              onClick={() => onGoToSolicitar()}
              disabled={isSubmitting}
              className="sm:w-1/3 py-3 px-4 rounded-xl border border-slate-300 text-slate-700 font-semibold hover:bg-slate-50 transition-colors cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex-1 py-3 px-6 rounded-xl bg-[#2B3E4C] hover:bg-[#1E2C36] disabled:bg-slate-300 text-white font-bold shadow-md hover:shadow-lg transition-all flex items-center justify-center gap-2 cursor-pointer"
            >
              {isSubmitting ? (
                <>
                  <span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
                  <span>Registrando agente...</span>
                </>
              ) : (
                <>
                  <UserPlus className="w-4 h-4 text-[#87b867]" />
                  <span>Registrar Agente</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
