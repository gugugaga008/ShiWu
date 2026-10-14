import {
  BarChart3,
  ContactRound,
  UserRoundPlus,
  History,
  LayoutDashboard,
  Scale,
  Settings,
  Users,
} from 'lucide-react'
import { type SidebarData } from '../types'

export const sidebarData: SidebarData = {
  navGroups: [
    {
      title: '监控',
      items: [
        {
          title: '概览',
          url: '/',
          icon: LayoutDashboard,
        },
        {
          title: '人员管理',
          icon: Users,
          items: [
            { title: '人员列表', url: '/people', icon: ContactRound },
            { title: '添加人员', url: '/people/add', icon: UserRoundPlus },
          ],
        },
      ],
    },
    {
      title: '预警',
      items: [
        {
          title: '规则设置',
          url: '/rules',
          icon: Scale,
        },
        {
          title: '时间线',
          url: '/timeline',
          icon: History,
        },
        {
          title: '统计',
          url: '/stats',
          icon: BarChart3,
        },
      ],
    },
    {
      title: '系统',
      items: [
        {
          title: '设置',
          url: '/settings',
          icon: Settings,
        },
      ],
    },
  ],
}
