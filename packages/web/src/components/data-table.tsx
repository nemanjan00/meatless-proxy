import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  type SortingState,
  tableFeatures,
  useTable,
} from '@tanstack/react-table'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { type ReactNode, useMemo } from 'react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.tsx'
import { cn } from '@/lib/utils.ts'

/** A column of a `DataTable`: how to read the sort value and how to render the cell. */
export interface DataColumn<T> {
  id: string
  header: string
  value: (row: T) => string | number
  cell?: (row: T) => ReactNode
  align?: 'left' | 'right'
  className?: string
  sortable?: boolean
}

const features = tableFeatures({ rowSortingFeature, sortedRowModel: createSortedRowModel() })

/**
 * shadcn's data-table pattern on TanStack Table v9: sortable headers, dense
 * 36px rows, hairline borders, metadata in tertiary text.
 */
export function DataTable<T extends object>({
  rows,
  columns,
  initialSort,
  onRowClick,
  rowKey,
  className,
}: {
  rows: T[]
  columns: DataColumn<T>[]
  initialSort?: SortingState
  onRowClick?: (row: T) => void
  rowKey: (row: T) => string
  className?: string
}) {
  const helper = useMemo(() => createColumnHelper<typeof features, T>(), [])
  const defs = useMemo(
    () =>
      helper.columns(
        columns.map((c) =>
          helper.accessor((row: T) => c.value(row), {
            id: c.id,
            header: c.header,
            enableSorting: c.sortable !== false,
            sortFn: (a, b, colId) => {
              const x = a.getValue(colId) as string | number
              const y = b.getValue(colId) as string | number
              return x < y ? -1 : x > y ? 1 : 0
            },
            cell: (info) => (c.cell ? c.cell(info.row.original) : String(info.getValue())),
          }),
        ),
      ),
    [columns, helper],
  )
  const table = useTable({
    features,
    columns: defs,
    data: rows,
    getRowId: (r: T) => rowKey(r),
    initialState: { sorting: initialSort ?? [] },
  })
  const byId = new Map(columns.map((c) => [c.id, c]))
  return (
    <Table className={cn('text-mini', className)}>
      <TableHeader>
        {table.getHeaderGroups().map((g) => (
          <TableRow key={g.id} className="hover:bg-transparent">
            {g.headers.map((h) => {
              const col = byId.get(h.column.id)
              const sorted = h.column.getIsSorted()
              return (
                <TableHead
                  key={h.id}
                  className={cn(
                    'h-8 text-micro font-medium text-fg-tertiary',
                    col?.align === 'right' && 'text-right',
                    col?.className,
                  )}
                  aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
                >
                  {h.column.getCanSort() ? (
                    <button
                      type="button"
                      onClick={h.column.getToggleSortingHandler()}
                      className={cn(
                        'inline-flex items-center gap-1 hover:text-foreground',
                        col?.align === 'right' && 'flex-row-reverse',
                      )}
                    >
                      {col?.header}
                      {sorted === 'asc' ? (
                        <ArrowUp className="size-3" />
                      ) : sorted === 'desc' ? (
                        <ArrowDown className="size-3" />
                      ) : null}
                    </button>
                  ) : (
                    col?.header
                  )}
                </TableHead>
              )
            })}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.map((row) => (
          <TableRow
            key={row.id}
            className={cn('h-9 border-0', onRowClick && 'cursor-pointer')}
            onClick={onRowClick ? () => onRowClick(row.original) : undefined}
          >
            {row.getAllCells().map((cell) => {
              const col = byId.get(cell.column.id)
              return (
                <TableCell
                  key={cell.id}
                  className={cn('py-1.5 text-fg-secondary', col?.align === 'right' && 'text-right tabular-nums', col?.className)}
                >
                  <table.FlexRender cell={cell} />
                </TableCell>
              )
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
