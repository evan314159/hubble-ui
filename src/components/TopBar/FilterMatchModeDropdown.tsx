import { Menu, MenuItem, PopoverNext } from '@blueprintjs/core';
import { find } from 'lodash';
import React, { memo, useCallback } from 'react';

import { usePopover } from '~/ui/hooks/usePopover';
import { FilterMatchMode } from '~/domain/filtering';

import { FilterIcon } from './FilterIcon';

import css from './styles.scss';

export interface Props {
  mode: FilterMatchMode;
  onSelect?: (mode: FilterMatchMode) => void;
}

interface ModeOption {
  mode: FilterMatchMode;
  title: string;
}

const modes: ModeOption[] = [
  {
    mode: FilterMatchMode.Or,
    title: 'Match any filter (OR)',
  },
  {
    mode: FilterMatchMode.And,
    title: 'Match all filters (AND)',
  },
];

export const FilterMatchModeDropdown = memo<Props>(function FilterMatchModeDropdown(props) {
  const popover = usePopover();

  const getLabel = useCallback(() => {
    const found = find(modes, m => m.mode === props.mode);
    return found ? found.mode.toUpperCase() : '';
  }, [props.mode]);

  const content = (
    <Menu>
      {modes.map(m => (
        <MenuItem
          key={m.mode}
          active={props.mode === m.mode}
          text={m.title}
          onClick={() => props.onSelect?.(m.mode)}
        />
      ))}
    </Menu>
  );

  return (
    <PopoverNext {...popover.props} content={content}>
      <FilterIcon text={getLabel()} onClick={popover.toggle} className={css.textOnly} />
    </PopoverNext>
  );
});
