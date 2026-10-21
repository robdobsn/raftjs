import React, { useState } from 'react';
import DispOneLED from './DispOneLed';
import ConnManager from './ConnManager';
import { DeviceTypeAction } from '../../../src/RaftDeviceInfo';

const connManager = ConnManager.getInstance();

interface LEDGridProps {
  rows: number;
  cols: number;
  deviceKey: string;
  deviceAction: DeviceTypeAction;
}

const customColors = [
    '#000000', // black
    '#FFFFFF', // white
    '#FF0000', // red
    '#00FF00', // green
    '#0000FF', // blue
    '#FFFF00', // yellow
    '#FF00FF', // pink
    '#00FFFF', // cyan
    '#FFA500', // orange
    '#800080', // purple
    '#808080', // gray
    '#A52A2A', // brown
    '#008000', // dark green
    '#800000', // maroon
    '#008080', // teal
    '#000080', // navy
    '#FFD700', // gold
    '#FF4500', // orange red
    '#FF6347', // tomato
    // Add more custom colors as needed
  ];

// Row of colour swatches (laid out like react-color's CirclePicker) with the current colour ringed
const ColourSwatches: React.FC<{ colours: string[]; selected: string; onSelect: (colour: string) => void }> = ({ colours, selected, onSelect }) => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px', width: '252px', marginTop: '14px' }}>
    {colours.map((colour) => {
      const isSelected = colour.toLowerCase() === selected.toLowerCase();
      return (
        <button
          key={colour}
          type="button"
          title={colour}
          aria-label={colour}
          onClick={() => onSelect(colour)}
          style={{
            width: '28px',
            height: '28px',
            padding: 0,
            borderRadius: '50%',
            border: 'none',
            cursor: 'pointer',
            background: colour,
            boxShadow: isSelected ? `inset 0 0 0 3px ${colour}, inset 0 0 0 6px #fff` : `inset 0 0 0 14px ${colour}, 0 0 0 1px #888`,
          }}
        />
      );
    })}
  </div>
);
  
const DispLEDGrid: React.FC<LEDGridProps> = ({ rows, cols, deviceKey, deviceAction }) => {
  // Initialize the grid with all LEDs turned off (black)
  const [colors, setColors] = useState<string[][]>(
    Array.from({ length: rows }, () => Array.from({ length: cols }, () => '#000000'))
  );
  const [activeLED, setActiveLED] = useState<{row: number, col: number} | null>(null);

  const handleLEDClick = (row: number, col: number) => {
    setActiveLED({ row, col });
  };

  const hexToRgb = (hex: string): number[] => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return [r, g, b];
  };

  const handleColourSelect = (colour: string) => {
    if (activeLED) {
      const { row, col } = activeLED;
      const newColors = colors.map((rowColors, rowIndex) =>
        rowColors.map((colColor, colIndex) =>
          rowIndex === row && colIndex === col ? colour : colColor
        )
      );
      setColors(newColors);
      setActiveLED(null); // Optionally close the picker automatically

      // Convert into a list of RGB values
      let colourList = [];
      for (let i = 0; i < rows; i++) {
        for (let j = 0; j < cols; j++) {
          colourList.push(hexToRgb(newColors[i][j]));
        }
      }

      // Send result
      const deviceManager = connManager.getConnector().getSystemType()?.deviceMgrIF;
      if (deviceManager) {
        deviceManager.sendCompoundAction(deviceKey, deviceAction, colourList);
      }
    }
  };

  return (
    <div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${cols}, 24px)`,
        gridTemplateRows: `${rows === 1 ? '1fr' : `repeat(${rows}, 24px)`}`,
        justifyContent: 'center',
        width: `${cols * 24}px`
      }}>
        {colors.map((row, rowIndex) =>
          row.map((color, colIndex) => (
            <DispOneLED key={`${rowIndex}-${colIndex}`} color={color} onClick={() => handleLEDClick(rowIndex, colIndex)} />
          ))
        )}
      </div>
      {activeLED && (
        <ColourSwatches
          colours={customColors}
          selected={colors[activeLED.row][activeLED.col]}
          onSelect={handleColourSelect}
        />
      )}
    </div>
  );
};

export default DispLEDGrid;
