import type { ApiRecord, EmployeeData } from '@mp/api'
import { createContext, type ReactNode, useContext, useMemo, useState } from 'react'
import { useLoad } from '@/lib/api.tsx'

/**
 * The employee switcher's state. Each employee is a workspace (stylebook);
 * `null` shows all employees.
 */
interface EmployeesState {
  employees: ApiRecord<EmployeeData>[]
  current: ApiRecord<EmployeeData> | null
  currentId: string | null
  setCurrentId(id: string | null): void
  name(id: string): string
  reload(): void
}

const Ctx = createContext<EmployeesState | null>(null)
const KEY = 'mp.employee'

export function EmployeesProvider({ children }: { children: ReactNode }) {
  const { data, reload } = useLoad((api) => api.listRecords<EmployeeData>('employee', { orderBy: 'name', dir: 'asc' }), [])
  const [currentId, setId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(KEY)
    } catch {
      return null
    }
  })
  const value = useMemo<EmployeesState>(() => {
    const employees = data?.items ?? []
    const current = employees.find((e) => e.id === currentId) ?? null
    return {
      employees,
      current,
      currentId: current ? currentId : null,
      setCurrentId: (id) => {
        setId(id)
        try {
          if (id) localStorage.setItem(KEY, id)
          else localStorage.removeItem(KEY)
        } catch {
          // storage unavailable
        }
      },
      name: (id) => employees.find((e) => e.id === id)?.data.name ?? id,
      reload,
    }
  }, [data, currentId, reload])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useEmployees(): EmployeesState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useEmployees outside EmployeesProvider')
  return ctx
}

/** `@billing-bot` for "Billing Bot". */
export function employeeHandle(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}
