import {
  BarChart3,
  Camera,
  History,
  LayoutDashboard,
  Scale,
  Settings,
  Users,
  Video,
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
          title: '视频源',
          url: '/sources',
          icon: Video,
        },
        {
          title: '一键采集',
          url: '/capture',
          icon: Camera,
        },
        {
          title: '人员管理',
          url: '/people',
          icon: Users,
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
