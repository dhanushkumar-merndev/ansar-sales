"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Tabs as TabsPrimitive } from "radix-ui"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-horizontal:flex-col max-w-full",
        className
      )}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit max-w-full items-center justify-start rounded-xl p-1 text-muted-foreground group-data-horizontal/tabs:h-9 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none overflow-x-auto no-scrollbar scroll-smooth overscroll-x-contain",
  {
    variants: {
      variant: {
        default: "bg-[#262626] border border-white/[0.08]",
        line: "gap-1 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function TabsList({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  )
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  const ref = React.useRef<React.ComponentRef<typeof TabsPrimitive.Trigger>>(null)

  // Keep the active tab visible in a horizontally scrolling tab list. Only the list scrolls,
  // sideways: scrollIntoView would also scroll the page back up to the tabs on every render.
  React.useEffect(() => {
    const el = ref.current
    const list = el?.parentElement
    if (!el || !list || !(el.dataset.state === "active" || el.getAttribute("data-active") === "true")) return
    if (list.scrollWidth <= list.clientWidth) return
    const box = list.getBoundingClientRect()
    const tab = el.getBoundingClientRect()
    if (tab.left < box.left) list.scrollBy({ left: tab.left - box.left - 8, behavior: "smooth" })
    else if (tab.right > box.right) list.scrollBy({ left: tab.right - box.right + 8, behavior: "smooth" })
  })

  return (
    <TabsPrimitive.Trigger
      ref={ref}
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex h-full flex-1 shrink-0 items-center justify-center gap-1.5 rounded-lg px-3 py-1 text-xs font-medium whitespace-nowrap text-muted-foreground transition-all group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start hover:text-foreground focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50",
        "data-[state=active]:bg-white! data-[state=active]:text-black! data-[state=active]:font-semibold data-[state=active]:shadow-xs data-[state=active]:hover:text-black! data-[state=active]:hover:bg-white!",
        "dark:data-[state=active]:bg-white! dark:data-[state=active]:text-black! dark:data-[state=active]:hover:text-black!",
        "data-active:bg-white! data-active:text-black! data-active:font-semibold data-active:shadow-xs data-active:hover:text-black!",
        "dark:data-active:bg-white! dark:data-active:text-black! dark:data-active:hover:text-black!",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 text-sm outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
